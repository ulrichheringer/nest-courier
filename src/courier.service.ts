import { Inject, Injectable, Logger, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { COURIER_OPTIONS, positive, retryPolicy, validateOptions } from './config';
import { backoffMs, retryAfterMs } from './retry';
import { assertJson } from './payload';
import { signWebhook } from './signature';
import { MemoryCourierStore } from './stores/memory.store';
import { HttpCourierTransport, UnsafeWebhookUrlError, validateWebhookUrl } from './transport';
import {
  CourierNotification,
  CourierOptions,
  CourierStore,
  CourierTransport,
  Delivery,
  DeliveryQuery,
  Endpoint,
  EnqueueInput,
  PublishInput,
} from './types';

const RESERVED = new Set([
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'x-courier-id',
  'x-courier-event',
  'x-courier-event-id',
  'x-courier-attempt',
  'x-courier-signature',
  'user-agent',
]);
export function matchesEvent(pattern: string, event: string): boolean {
  return (
    pattern === '*' ||
    pattern === event ||
    (pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1)))
  );
}

@Injectable()
export class CourierService implements OnModuleInit, OnApplicationShutdown {
  readonly store: CourierStore;
  private readonly transport: CourierTransport;
  private readonly logger = new Logger(CourierService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;
  private stopped = false;
  constructor(@Inject(COURIER_OPTIONS) private readonly options: CourierOptions) {
    validateOptions(options);
    this.store = options.store ?? new MemoryCourierStore();
    this.transport = options.transport ?? new HttpCourierTransport(options);
  }
  async onModuleInit(): Promise<void> {
    for (const endpoint of this.options.endpoints ?? []) await this.registerEndpoint(endpoint);
    if (this.options.worker?.enabled !== false) this.start();
  }
  start(): void {
    if (this.stopped) throw new Error('Courier has shut down');
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => this.reportWorkerError(error));
    }, this.options.worker?.pollIntervalMs ?? 500);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.stop();
    await this.transport.close?.();
    await this.store.close?.();
  }
  private reportWorkerError(error: unknown): void {
    this.logger.error('Courier worker failed; queued work remains in the store');
    try {
      this.options.onWorkerError?.(error);
    } catch {
      this.logger.error('Courier error observer failed');
    }
  }
  private async notify(notification: CourierNotification): Promise<void> {
    try {
      await this.options.onNotification?.(notification);
    } catch {
      this.logger.warn('Courier notification observer failed');
    }
  }
  private validateEndpoint(endpoint: Endpoint): void {
    if (
      !endpoint.id ||
      !endpoint.events.length ||
      endpoint.events.some((e) => !e || /[\r\n]/.test(e))
    )
      throw new Error('Endpoint requires ID and event subscriptions');
    validateWebhookUrl(endpoint.url, this.options);
    retryPolicy(this.options.retry, endpoint.retry);
    const timeout = positive(
      endpoint.timeoutMs ?? this.options.timeoutMs ?? 10_000,
      'endpoint timeoutMs',
    );
    if (timeout + 1_000 >= (this.options.worker?.leaseMs ?? 60_000))
      throw new Error('Worker leaseMs must exceed endpoint timeoutMs by more than 1000ms');
    for (const [key, value] of Object.entries(endpoint.headers ?? {}))
      this.validateHeader(key, value);
    if (endpoint.auth?.type === 'api-key') {
      this.validateHeader(endpoint.auth.header, endpoint.auth.value);
      if (endpoint.auth.header.toLowerCase() === 'authorization')
        throw new Error('Use bearer or basic auth for Authorization');
    }
    if (
      endpoint.auth?.type === 'bearer' &&
      (!endpoint.auth.token || /[\r\n]/.test(endpoint.auth.token))
    )
      throw new Error('Invalid bearer token');
    if (endpoint.auth?.type === 'api-key' && !endpoint.auth.value)
      throw new Error('API key must not be empty');
    if (
      endpoint.auth?.type === 'basic' &&
      (!endpoint.auth.username || endpoint.auth.username.includes(':') || !endpoint.auth.password)
    )
      throw new Error('Basic auth requires username without colon and a password');
    if (endpoint.secret !== undefined && !endpoint.secret)
      throw new Error('Signing secret must not be empty');
  }
  private validateHeader(key: string, value: string): void {
    if (
      !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(key) ||
      /[\r\n]/.test(value) ||
      RESERVED.has(key.toLowerCase())
    )
      throw new Error('Invalid or reserved webhook header');
  }
  async registerEndpoint(endpoint: Endpoint): Promise<void> {
    this.validateEndpoint(endpoint);
    await this.store.putEndpoint(endpoint);
  }
  listEndpoints(): Promise<Endpoint[]> {
    return this.store.listEndpoints();
  }
  removeEndpoint(id: string): Promise<void> {
    return this.store.removeEndpoint(id);
  }
  async enqueue(input: EnqueueInput): Promise<Delivery> {
    const endpoint: Endpoint = {
      id: 'direct',
      url: input.url,
      events: [input.event],
      secret: input.secret,
      auth: input.auth,
      headers: input.headers,
      retry: input.retry,
      timeoutMs: input.timeoutMs,
    };
    return this.queue(
      endpoint,
      input,
      input.idempotencyKey ? this.key('direct', input.idempotencyKey) : undefined,
    );
  }
  /** Supplying a stable eventId makes partial fanout retries safe per endpoint. */
  async publish(input: PublishInput): Promise<Delivery[]> {
    const eventId = input.eventId ?? randomUUID();
    const endpoints = (await this.store.listEndpoints()).filter(
      (endpoint) =>
        endpoint.enabled !== false &&
        endpoint.events.some((pattern) => matchesEvent(pattern, input.event)),
    );
    const deliveries: Delivery[] = [];
    for (const endpoint of endpoints)
      deliveries.push(
        await this.queue(
          endpoint,
          { ...input, eventId },
          this.key('publish', endpoint.id, eventId),
        ),
      );
    return deliveries;
  }
  private key(...parts: string[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
  private async queue(
    endpoint: Endpoint,
    input: PublishInput,
    deduplicationKey?: string,
  ): Promise<Delivery> {
    this.validateEndpoint(endpoint);
    if (!input.event || /[^\x20-\x7E]/.test(input.event))
      throw new Error('Event must be a non-empty ASCII header value');
    const now = Date.now();
    const eventId = input.eventId ?? randomUUID();
    if (!eventId || /[^\x21-\x7E]/.test(eventId)) throw new Error('Invalid eventId');
    const scheduledAt = input.scheduledAt ?? now;
    if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0)
      throw new Error('Invalid scheduledAt');
    const id = randomUUID();
    assertJson(input.payload);
    const body = JSON.stringify({
      id: eventId,
      type: input.event,
      createdAt: new Date(now).toISOString(),
      data: input.payload,
    });
    if (Buffer.byteLength(body) > (this.options.maxPayloadBytes ?? 1_048_576))
      throw new Error('Webhook payload exceeds size limit');
    const delivery = await this.store.enqueue({
      id,
      eventId,
      event: input.event,
      endpoint: structuredClone(endpoint),
      body,
      status: 'pending',
      createdAt: now,
      nextAttemptAt: scheduledAt,
      attempts: [],
      cycleAttempts: 0,
      deduplicationKey,
    });
    if (delivery.id === id) await this.notify({ type: 'queued', deliveryId: id, eventId });
    return delivery;
  }
  getDelivery(id: string): Promise<Delivery | undefined> {
    return this.store.get(id);
  }
  listDeliveries(query?: DeliveryQuery): Promise<Delivery[]> {
    return this.store.list(query);
  }
  async cancel(id: string): Promise<boolean> {
    const cancelled = await this.store.cancel(id);
    if (cancelled) {
      const d = await this.store.get(id);
      if (d) await this.notify({ type: 'cancelled', deliveryId: id, eventId: d.eventId });
    }
    return cancelled;
  }
  redrive(id: string): Promise<boolean> {
    return this.store.redrive(id, Date.now());
  }
  prune(before: number): Promise<number> {
    return this.store.prune(before);
  }
  runOnce(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.running) return this.running;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async work(): Promise<number> {
    const limit = Math.min(
      this.options.worker?.batchSize ?? 100,
      this.options.worker?.concurrency ?? 8,
    );
    const deliveries = await this.store.claimDue(
      Date.now(),
      limit,
      this.options.worker?.leaseMs ?? 60_000,
    );
    const results = await Promise.allSettled(deliveries.map((delivery) => this.deliver(delivery)));
    for (const result of results)
      if (result.status === 'rejected') this.reportWorkerError(result.reason);
    return deliveries.length;
  }
  private headers(d: Delivery): Record<string, string> {
    const headers: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(d.endpoint.headers ?? {}))
      headers[key.toLowerCase()] = value;
    Object.assign(headers, {
      'content-type': 'application/json',
      'user-agent': 'nest-courier/0.1',
      'x-courier-id': d.id,
      'x-courier-event': d.event,
      'x-courier-event-id': d.eventId,
      'x-courier-attempt': String(d.attempts.length + 1),
    });
    const auth = d.endpoint.auth;
    if (auth?.type === 'bearer') headers.authorization = `Bearer ${auth.token}`;
    if (auth?.type === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
    if (auth?.type === 'api-key') headers[auth.header.toLowerCase()] = auth.value;
    if (d.endpoint.secret)
      headers['x-courier-signature'] = signWebhook(d.body, d.endpoint.secret, d.id);
    return headers;
  }
  private async deliver(d: Delivery): Promise<void> {
    const startedAt = Date.now();
    const policy = retryPolicy(this.options.retry, d.endpoint.retry);
    let retryable = true;
    let statusCode: number | undefined;
    let error: string | undefined;
    let serverDelay = 0;
    try {
      const response = await this.transport.send({
        url: d.endpoint.url,
        body: d.body,
        headers: this.headers(d),
        timeoutMs: d.endpoint.timeoutMs ?? this.options.timeoutMs ?? 10_000,
        maxResponseBytes: this.options.maxResponseBytes ?? 65_536,
      });
      statusCode = response.statusCode;
      retryable = policy.retryStatusCodes.includes(statusCode);
      serverDelay = retryAfterMs(response.headers['retry-after']) ?? 0;
      if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
    } catch (cause) {
      // Never persist arbitrary error messages from transports: they can contain credentials/URLs.
      error =
        cause instanceof UnsafeWebhookUrlError
          ? 'Unsafe destination'
          : 'Transport failure or timeout';
      retryable = !(cause instanceof UnsafeWebhookUrlError);
    }
    const attempt = {
      number: d.attempts.length + 1,
      startedAt,
      durationMs: Date.now() - startedAt,
      statusCode,
      error,
    };
    d.attempts.push(attempt);
    d.cycleAttempts++;
    if (statusCode !== undefined && statusCode >= 200 && statusCode < 300 && !error)
      d.status = 'delivered';
    else if (!retryable || d.cycleAttempts >= policy.maxAttempts) d.status = 'dead';
    else {
      d.status = 'pending';
      d.nextAttemptAt =
        Date.now() +
        Math.min(policy.maxDelayMs, Math.max(backoffMs(d.cycleAttempts, policy), serverDelay));
    }
    if (await this.store.settle(d, d.leaseToken!))
      await this.notify({
        type: d.status === 'pending' ? 'retry' : d.status,
        deliveryId: d.id,
        eventId: d.eventId,
        attempt,
      });
  }
}

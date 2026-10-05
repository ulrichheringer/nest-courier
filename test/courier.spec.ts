import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CourierInboxService,
  CourierService,
  CourierTransport,
  MemoryCourierStore,
  TransportRequest,
  verifyWebhook,
} from '../src';
const services: CourierService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.onApplicationShutdown();
});
function setup(
  send: CourierTransport['send'],
  options: ConstructorParameters<typeof CourierService>[0] = {},
) {
  const service = new CourierService({
    worker: { enabled: false },
    ...options,
    transport: { send },
  });
  services.push(service);
  return service;
}
const input = {
  url: 'https://example.com/hook',
  event: 'order.created',
  payload: { total: 42 },
  secret: 'secret',
};
describe('outbound delivery', () => {
  it('sends a signed stable envelope with authentication and emits notifications', async () => {
    let request!: TransportRequest;
    const notify = vi.fn();
    const service = setup(
      async (r) => {
        request = r;
        return { statusCode: 204, headers: {} };
      },
      { onNotification: notify },
    );
    const d = await service.enqueue({
      ...input,
      auth: { type: 'bearer', token: 'token' },
      headers: { 'x-tenant': 'tenant' },
    });
    await service.runOnce();
    expect(request.headers.authorization).toBe('Bearer token');
    expect(request.headers['x-tenant']).toBe('tenant');
    expect(
      verifyWebhook(request.body, request.headers['x-courier-signature']!, {
        secrets: ['secret'],
        id: d.id,
      }),
    ).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      id: d.eventId,
      type: 'order.created',
      data: { total: 42 },
    });
    expect((await service.getDelivery(d.id))!.status).toBe('delivered');
    expect(notify.mock.calls.map((c) => c[0].type)).toEqual(['queued', 'delivered']);
  });
  it('honors Retry-After, preserves body and ID, exhausts budget, then redrives with history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const send = vi.fn().mockResolvedValue({ statusCode: 429, headers: { 'retry-after': '2' } });
    const service = setup(send, { retry: { maxAttempts: 2, initialDelayMs: 100, jitter: 'none' } });
    const d = await service.enqueue(input);
    await service.runOnce();
    expect((await service.getDelivery(d.id))!.nextAttemptAt).toBe(12_000);
    expect(await service.runOnce()).toBe(0);
    vi.setSystemTime(12_000);
    await service.runOnce();
    expect((await service.getDelivery(d.id))!.status).toBe('dead');
    expect(send.mock.calls[0]![0].body).toBe(send.mock.calls[1]![0].body);
    expect(await service.redrive(d.id)).toBe(true);
    send.mockResolvedValue({ statusCode: 200, headers: {} });
    await service.runOnce();
    const result = (await service.getDelivery(d.id))!;
    expect(result.status).toBe('delivered');
    expect(result.attempts).toHaveLength(3);
    expect(result.cycleAttempts).toBe(1);
  });
  it('does not retry permanent 4xx or follow redirects', async () => {
    for (const code of [400, 401, 302]) {
      const service = setup(async () => ({ statusCode: code, headers: {} }));
      const d = await service.enqueue(input);
      await service.runOnce();
      expect((await service.getDelivery(d.id))!.status).toBe('dead');
    }
  });
  it('retries transport failures without leaking error messages', async () => {
    const service = setup(async () => {
      throw new Error('Bearer SECRET');
    });
    const d = await service.enqueue(input);
    await service.runOnce();
    const result = (await service.getDelivery(d.id))!;
    expect(result.status).toBe('pending');
    expect(JSON.stringify(result.attempts)).not.toContain('SECRET');
  });
  it('fans out subscriptions and deduplicates publish per endpoint', async () => {
    const service = setup(async () => ({ statusCode: 200, headers: {} }));
    await service.registerEndpoint({ id: 'orders', url: input.url, events: ['order.*'] });
    await service.registerEndpoint({ id: 'all', url: input.url, events: ['*'] });
    await service.registerEndpoint({ id: 'off', url: input.url, events: ['*'], enabled: false });
    await service.registerEndpoint({ id: 'payments', url: input.url, events: ['payment.created'] });
    const event = { event: input.event, payload: input.payload, eventId: 'stable' };
    const first = await service.publish(event);
    const second = await service.publish(event);
    expect(first).toHaveLength(2);
    expect(second.map((d) => d.id)).toEqual(first.map((d) => d.id));
  });
  it('deduplicates direct enqueue and validates unsafe inputs', async () => {
    const service = setup(async () => ({ statusCode: 200, headers: {} }));
    const first = await service.enqueue({ ...input, idempotencyKey: 'one' });
    const second = await service.enqueue({ ...input, idempotencyKey: 'one' });
    expect(second.id).toBe(first.id);
    await expect(
      service.enqueue({ ...input, headers: { 'X-Courier-ID': 'spoofed' } }),
    ).rejects.toThrow();
    await expect(
      service.enqueue({ ...input, headers: { 'x-name': 'x\r\nAuthorization: y' } }),
    ).rejects.toThrow();
    await expect(service.enqueue({ ...input, timeoutMs: 60_000 })).rejects.toThrow();
    await expect(service.enqueue({ ...input, url: 'https://127.0.0.1' })).rejects.toThrow();
    await expect(service.enqueue({ ...input, event: 'bad\nheader' })).rejects.toThrow();
  });
  it('bounds concurrency and coalesces overlapping worker ticks', async () => {
    let active = 0;
    let max = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = setup(
      async () => {
        active++;
        max = Math.max(max, active);
        await wait;
        active--;
        return { statusCode: 200, headers: {} };
      },
      { worker: { enabled: false, concurrency: 2 } },
    );
    for (let i = 0; i < 4; i++) await service.enqueue(input);
    const first = service.runOnce();
    expect(service.runOnce()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    release();
    await first;
    expect(max).toBe(2);
    expect(await service.listDeliveries({ status: 'pending' })).toHaveLength(2);
    await service.runOnce();
    expect(await service.listDeliveries({ status: 'delivered' })).toHaveLength(4);
  });
  it('isolates observer failures from delivery outcomes', async () => {
    const service = setup(async () => ({ statusCode: 200, headers: {} }), {
      onNotification: () => {
        throw new Error('observer');
      },
    });
    const d = await service.enqueue(input);
    await service.runOnce();
    expect((await service.getDelivery(d.id))!.status).toBe('delivered');
  });
});
describe('inbox', () => {
  it('deduplicates completed work and releases failed handlers', async () => {
    const courier = setup(async () => ({ statusCode: 200, headers: {} }), {
      store: new MemoryCourierStore(),
    });
    const inbox = new CourierInboxService(courier);
    const options = { namespace: 'provider', id: 'one' };
    const handler = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue('ok');
    await expect(inbox.handle(options, handler)).rejects.toThrow('failed');
    expect(await inbox.handle(options, handler)).toEqual({ duplicate: false, value: 'ok' });
    expect(await inbox.handle(options, handler)).toEqual({ duplicate: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await inbox.handle({ ...options, namespace: 'other' }, handler)).toEqual({
      duplicate: false,
      value: 'ok',
    });
  });
});

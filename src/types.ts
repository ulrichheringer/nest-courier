import type { ModuleMetadata, InjectionToken } from '@nestjs/common';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DeliveryStatus = 'pending' | 'processing' | 'delivered' | 'dead' | 'cancelled';
export type Auth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'api-key'; header: string; value: string };
export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: 'none' | 'full' | 'equal';
  retryStatusCodes: number[];
}
export interface Endpoint {
  id: string;
  url: string;
  events: string[];
  enabled?: boolean;
  secret?: string;
  auth?: Auth;
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
}
export interface DeliveryAttempt {
  number: number;
  startedAt: number;
  durationMs: number;
  statusCode?: number;
  error?: string;
}
/** Authentication is snapshotted at enqueue time. Protect the store like credentials. */
export interface Delivery {
  id: string;
  eventId: string;
  event: string;
  endpoint: Endpoint;
  body: string;
  status: DeliveryStatus;
  createdAt: number;
  nextAttemptAt: number;
  attempts: DeliveryAttempt[];
  cycleAttempts: number;
  leaseToken?: string;
  leaseUntil?: number;
  deduplicationKey?: string;
}
export interface EnqueueInput {
  url: string;
  event: string;
  payload: Json;
  eventId?: string;
  secret?: string;
  auth?: Auth;
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  scheduledAt?: number;
  idempotencyKey?: string;
}
export interface PublishInput {
  event: string;
  payload: Json;
  eventId?: string;
  scheduledAt?: number;
}
export interface TransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface TransportResponse {
  statusCode: number;
  headers: Record<string, string>;
}
export interface CourierTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
  close?(): Promise<void>;
}
export interface DeliveryQuery {
  status?: DeliveryStatus;
  endpointId?: string;
  limit?: number;
  offset?: number;
}
export type CourierNotification = {
  type: 'queued' | 'delivered' | 'retry' | 'dead' | 'cancelled';
  deliveryId: string;
  eventId: string;
  attempt?: DeliveryAttempt;
};
export interface CourierOptions {
  store?: CourierStore;
  transport?: CourierTransport;
  endpoints?: Endpoint[];
  retry?: Partial<RetryPolicy>;
  worker?: {
    enabled?: boolean;
    concurrency?: number;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
  };
  timeoutMs?: number;
  maxPayloadBytes?: number;
  maxResponseBytes?: number;
  allowPrivateNetworks?: boolean;
  allowHttp?: boolean;
  allowedHosts?: string[];
  onNotification?: (notification: CourierNotification) => void | Promise<void>;
  onWorkerError?: (error: unknown) => void;
}
export interface CourierAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: InjectionToken[];
  useFactory: (...dependencies: any[]) => CourierOptions | Promise<CourierOptions>;
  global?: boolean;
}
/** claimDue and receipt operations MUST be atomic across all workers sharing a store. */
export interface CourierStore {
  putEndpoint(endpoint: Endpoint): Promise<void>;
  listEndpoints(): Promise<Endpoint[]>;
  removeEndpoint(id: string): Promise<void>;
  enqueue(delivery: Delivery): Promise<Delivery>;
  get(id: string): Promise<Delivery | undefined>;
  list(query?: DeliveryQuery): Promise<Delivery[]>;
  claimDue(now: number, limit: number, leaseMs: number): Promise<Delivery[]>;
  settle(delivery: Delivery, leaseToken: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  redrive(id: string, now: number): Promise<boolean>;
  claimReceipt(
    key: string,
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<'claimed' | 'duplicate' | 'busy'>;
  completeReceipt(key: string, token: string, expiresAt: number): Promise<boolean>;
  releaseReceipt(key: string, token: string): Promise<void>;
  prune(before: number): Promise<number>;
  close?(): void | Promise<void>;
}

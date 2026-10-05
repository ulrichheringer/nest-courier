import { CourierOptions, RetryPolicy } from './types';
export const COURIER_OPTIONS = Symbol('COURIER_OPTIONS');
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 3_600_000,
  multiplier: 2,
  jitter: 'full',
  retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
};
export function retryPolicy(...overrides: (Partial<RetryPolicy> | undefined)[]): RetryPolicy {
  const value: RetryPolicy = Object.assign({}, DEFAULT_RETRY, ...overrides);
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100)
    throw new Error('maxAttempts must be an integer between 1 and 100');
  for (const key of ['initialDelayMs', 'maxDelayMs', 'multiplier'] as const)
    if (!Number.isFinite(value[key]) || value[key] < 1) throw new Error(`Invalid retry ${key}`);
  if (value.maxDelayMs < value.initialDelayMs)
    throw new Error('maxDelayMs must be >= initialDelayMs');
  if (!['none', 'full', 'equal'].includes(value.jitter)) throw new Error('Invalid jitter');
  if (
    !Array.isArray(value.retryStatusCodes) ||
    value.retryStatusCodes.some((code) => !Number.isInteger(code) || code < 100 || code > 599)
  )
    throw new Error('Invalid retry status code');
  return value;
}
export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
export function validateOptions(options: CourierOptions): CourierOptions {
  retryPolicy(options.retry);
  positive(options.timeoutMs ?? 10_000, 'timeoutMs');
  positive(options.maxPayloadBytes ?? 1_048_576, 'maxPayloadBytes');
  positive(options.maxResponseBytes ?? 65_536, 'maxResponseBytes');
  positive(options.worker?.concurrency ?? 8, 'concurrency');
  positive(options.worker?.pollIntervalMs ?? 500, 'pollIntervalMs');
  positive(options.worker?.batchSize ?? 100, 'batchSize');
  positive(options.worker?.leaseMs ?? 60_000, 'leaseMs');
  return options;
}

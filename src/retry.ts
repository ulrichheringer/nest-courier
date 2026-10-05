import { RetryPolicy } from './types';
export function backoffMs(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const delay = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1),
  );
  if (policy.jitter === 'full') return Math.floor(random() * delay);
  if (policy.jitter === 'equal') return Math.floor(delay / 2 + (random() * delay) / 2);
  return delay;
}
export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+(\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header) * 1_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

import { Json } from './types';
/** Reject lossy JSON conversion (undefined, NaN, class instances) before persisting. */
export function assertJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): asserts value is Json {
  if (depth > 100) throw new Error('Webhook payload exceeds maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error('Webhook payload must be valid JSON');
  if (seen.has(value)) throw new Error('Webhook payload must not contain cycles');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Webhook payload requires plain JSON objects');
  seen.add(value);
  if (Array.isArray(value))
    for (let i = 0; i < value.length; i++) assertJson(value[i], seen, depth + 1);
  else for (const item of Object.values(value)) assertJson(item, seen, depth + 1);
  seen.delete(value);
}

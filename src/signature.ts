import { createHmac, timingSafeEqual } from 'node:crypto';
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Wire format: t=<unix-seconds>,v1=<sha256 hex>. Signed bytes: timestamp.id.rawBody. */
export function signWebhook(
  body: string | Buffer,
  secret: string,
  id: string,
  timestamp = Math.floor(Date.now() / 1_000),
): string {
  if (!secret || !id) throw new Error('Signing requires secret and delivery ID');
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${id}.`)
    .update(body)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}
export interface VerifySignatureOptions {
  secrets: string[];
  id: string;
  toleranceSeconds?: number;
  now?: number;
}
export function verifyWebhook(
  body: string | Buffer,
  signature: string,
  options: VerifySignatureOptions,
): boolean {
  if (!options.id || options.secrets.length === 0 || signature.length > 4096) return false;
  const parts = signature.split(',');
  const timestamps = parts.filter((part) => part.startsWith('t='));
  if (timestamps.length !== 1 || !/^t=\d+$/.test(timestamps[0]!)) return false;
  const timestamp = Number(timestamps[0]!.slice(2));
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(timestamp) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    Math.abs(now - timestamp) > tolerance
  )
    return false;
  const digests = parts
    .filter((part) => /^v1=[a-f0-9]{64}$/.test(part))
    .map((part) => part.slice(3));
  let valid = false;
  for (const secret of options.secrets) {
    if (!secret) continue;
    const expected = signWebhook(body, secret, options.id, timestamp).split('v1=')[1]!;
    for (const digest of digests) valid = safeEqual(expected, digest) || valid;
  }
  return valid;
}

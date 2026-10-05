import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  DEFAULT_RETRY,
  isPublicAddress,
  retryAfterMs,
  retryPolicy,
  signWebhook,
  validateWebhookUrl,
  verifyWebhook,
} from '../src';

describe('signed wire protocol', () => {
  const body = Buffer.from('{"text":"olá"}');
  const id = 'delivery-1';
  it('authenticates exact bytes and ID with rotated secrets', () => {
    const signature = signWebhook(body, 'new-secret', id, 1000);
    expect(
      verifyWebhook(body, signature, { secrets: ['old-secret', 'new-secret'], id, now: 1000 }),
    ).toBe(true);
    expect(
      verifyWebhook(Buffer.from('{ "text":"olá"}'), signature, {
        secrets: ['new-secret'],
        id,
        now: 1000,
      }),
    ).toBe(false);
    expect(
      verifyWebhook(body, signature, { secrets: ['new-secret'], id: 'other', now: 1000 }),
    ).toBe(false);
  });
  it('rejects expired, future, malformed and empty-secret signatures', () => {
    const signature = signWebhook(body, 'secret', id, 1000);
    for (const now of [699, 1301])
      expect(verifyWebhook(body, signature, { secrets: ['secret'], id, now })).toBe(false);
    for (const value of [
      't=1000,v1=x',
      't=1000,t=1000,v1=' + '0'.repeat(64),
      't=NaN,v1=' + '0'.repeat(64),
    ])
      expect(verifyWebhook(body, value, { secrets: ['secret'], id, now: 1000 })).toBe(false);
    expect(verifyWebhook(body, signature, { secrets: [''], id, now: 1000 })).toBe(false);
  });
});
describe('network policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '224.0.0.1',
    '100.64.0.1',
    '0.0.0.0',
  ])('blocks %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it('allows public IPs and requires opt-in for HTTP and private networks', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of [
      'http://example.com',
      'https://127.0.0.1',
      'https://[::1]',
      'https://user:pass@example.com',
      'file:///etc/passwd',
      'https://example.com/#hash',
    ])
      expect(() => validateWebhookUrl(url)).toThrow();
    expect(
      validateWebhookUrl('http://localhost', { allowHttp: true, allowPrivateNetworks: true })
        .hostname,
    ).toBe('localhost');
    expect(() =>
      validateWebhookUrl('https://evil.com', { allowedHosts: ['example.com'] }),
    ).toThrow();
  });
});
describe('retry policy', () => {
  it('exponentially backs off, caps and applies jitter', () => {
    const policy = retryPolicy({ initialDelayMs: 100, maxDelayMs: 500, jitter: 'none' });
    expect([1, 2, 3, 4].map((n) => backoffMs(n, policy))).toEqual([100, 200, 400, 500]);
    expect(backoffMs(2, { ...policy, jitter: 'full' }, () => 0.5)).toBe(100);
    expect(backoffMs(2, { ...policy, jitter: 'equal' }, () => 0.5)).toBe(150);
    expect(() => retryPolicy({ maxAttempts: 0 })).toThrow();
    expect(DEFAULT_RETRY.retryStatusCodes).toContain(429);
  });
  it('parses seconds and dates in Retry-After', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 5000)).toBe(5000);
    expect(retryAfterMs('garbage')).toBeUndefined();
  });
});

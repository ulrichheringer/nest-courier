import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { CourierOptions, CourierTransport, TransportRequest, TransportResponse } from './types';

export class UnsafeWebhookUrlError extends Error {}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function validateWebhookUrl(
  input: string,
  options: Pick<CourierOptions, 'allowHttp' | 'allowPrivateNetworks' | 'allowedHosts'> = {},
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeWebhookUrlError('Invalid webhook URL');
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:'))
    throw new UnsafeWebhookUrlError('Webhook URL requires HTTPS');
  if (url.username || url.password || url.hash)
    throw new UnsafeWebhookUrlError('URL credentials and fragments are forbidden');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (options.allowedHosts && !options.allowedHosts.includes(host))
    throw new UnsafeWebhookUrlError('Webhook host is not allowlisted');
  if (
    !options.allowPrivateNetworks &&
    (host.toLowerCase() === 'localhost' || (isIP(host) && !isPublicAddress(host)))
  )
    throw new UnsafeWebhookUrlError('Private webhook destinations are forbidden');
  return url;
}
/** DNS is checked inside the connection lookup, pinning the address actually dialed. */
export class HttpCourierTransport implements CourierTransport {
  private readonly agent: Agent;
  constructor(
    private readonly options: Pick<
      CourierOptions,
      'allowHttp' | 'allowPrivateNetworks' | 'allowedHosts'
    > = {},
  ) {
    this.agent = new Agent({
      connect: {
        lookup: (hostname, _options, callback) => {
          void lookup(hostname, { all: true, verbatim: true })
            .then((addresses) => {
              if (
                !addresses.length ||
                (!options.allowPrivateNetworks &&
                  addresses.some((a) => !isPublicAddress(a.address)))
              )
                throw new UnsafeWebhookUrlError('DNS resolved to a forbidden address');
              const address = addresses[0]!;
              if ((_options as { all?: boolean }).all) callback(null, addresses as any);
              else callback(null, address.address, address.family);
            })
            .catch((error: Error) => callback(error, '', 4));
        },
      },
    });
  }
  async send(input: TransportRequest): Promise<TransportResponse> {
    const url = validateWebhookUrl(input.url, this.options);
    const response = await request(url, {
      dispatcher: this.agent,
      method: 'POST',
      body: input.body,
      headers: input.headers,
      signal: AbortSignal.timeout(input.timeoutMs),
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers))
      if (value !== undefined)
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
    // No response payload is persisted. Drain only bounded bytes; reject oversized responses.
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > input.maxResponseBytes) {
        response.body.destroy();
        throw new Error('Webhook response exceeds size limit');
      }
    }
    return { statusCode: response.statusCode, headers };
  }
  async close(): Promise<void> {
    await this.agent.close();
  }
}

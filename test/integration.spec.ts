import {
  Body,
  Controller,
  Inject,
  INestApplication,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, RequestListener, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CourierModule,
  CourierService,
  HttpCourierTransport,
  signWebhook,
  WebhookReceiver,
  WebhookRequest,
} from '../src';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]),
}));
let filteredCalls = 0;
let calls = 0;
let failOnce = false;
@Controller('hooks')
class ReceiverController {
  @Post('basic')
  @WebhookReceiver({
    secrets: ['secret'],
    auth: { type: 'basic', username: 'user', password: 'pass' },
  })
  receiveBasic() {
    return { received: true };
  }

  @Post('api-key')
  @WebhookReceiver({
    secrets: ['secret'],
    auth: { type: 'api-key', header: 'x-api-key', value: 'key' },
  })
  receiveApiKey() {
    return { received: true };
  }

  @Post('filtered')
  @WebhookReceiver({
    secrets: ['secret'],
    events: ['order.*', 'invoice.paid'],
    inbox: { namespace: 'filtered' },
  })
  receiveFiltered(@Body() event: { type: string }) {
    filteredCalls++;
    return { type: event.type };
  }

  @Post()
  @WebhookReceiver({
    secrets: ['old-secret', 'secret'],
    auth: { type: 'bearer', token: 'token' },
    inbox: { namespace: 'orders' },
  })
  receive(@Req() request: WebhookRequest) {
    calls++;
    if (failOnce) {
      failOnce = false;
      throw new ServiceUnavailableException();
    }
    return { received: true, id: request.headers['x-courier-id'] };
  }
}
let app: INestApplication | undefined;
const transports: HttpCourierTransport[] = [];
const services: CourierService[] = [];
let server: Server | undefined;
afterEach(async () => {
  for (const service of services.splice(0)) await service.onApplicationShutdown();
  for (const transport of transports.splice(0)) await transport.close();
  await app?.close();
  app = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function receiver() {
  calls = 0;
  filteredCalls = 0;
  failOnce = false;
  const module = await Test.createTestingModule({
    imports: [CourierModule.forRoot({ worker: { enabled: false } })],
    controllers: [ReceiverController],
  }).compile();
  app = module.createNestApplication({ rawBody: true, logger: false });
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/hooks`;
}
function signed(body: string, id = 'one') {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer token',
    'x-courier-id': id,
    'x-courier-signature': signWebhook(body, 'secret', id),
  };
}
describe('NestJS receiver and real HTTP sender', () => {
  it('verifies auth, exact raw body, rotation and deduplicates completed requests', async () => {
    const url = await receiver();
    const body = '{ "data": "olá" }';
    const first = await fetch(url, { method: 'POST', body, headers: signed(body) });
    expect(first.status).toBe(201);
    const repeated = await fetch(url, { method: 'POST', body, headers: signed(body) });
    expect(await repeated.json()).toEqual({ received: true, duplicate: true });
    expect(calls).toBe(1);
    expect(
      (await fetch(url, { method: 'POST', body: '{"data":"olá"}', headers: signed(body, 'two') }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          body,
          headers: { ...signed(body, 'three'), authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
        .status,
    ).toBe(401);
  });
  it('authenticates Basic and API-key receivers', async () => {
    const url = await receiver();
    const body = '{}';
    for (const [route, auth] of [
      ['basic', { authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` }],
      ['api-key', { 'x-api-key': 'key' }],
    ] as const) {
      expect(
        (
          await fetch(`${url}/${route}`, {
            method: 'POST',
            body,
            headers: { ...signed(body), ...auth },
          })
        ).status,
      ).toBe(201);
      expect(
        (await fetch(`${url}/${route}`, { method: 'POST', body, headers: signed(body) })).status,
      ).toBe(401);
    }
  });
  it('filters authenticated events by signed body before reserving the inbox receipt', async () => {
    const url = `${await receiver()}/filtered`;
    const send = (body: string, id: string, eventHeader?: string) =>
      fetch(url, {
        method: 'POST',
        body,
        headers: { ...signed(body, id), 'x-courier-event': eventHeader ?? 'untrusted' },
      });
    expect((await send('{"type":"order.created"}', 'one')).status).toBe(201);
    expect((await send('{"type":"invoice.paid"}', 'two')).status).toBe(201);
    expect((await send('{"type":"order"}', 'three', 'order.created')).status).toBe(403);
    expect((await send('{"type":"invoice.failed"}', 'four', 'invoice.paid')).status).toBe(403);
    expect((await send('{}', 'five', 'order.created')).status).toBe(403);
    expect((await send('[]', 'six')).status).toBe(403);
    const unsigned = '{"type":"order.ignored"}';
    expect(
      (
        await fetch(url, {
          method: 'POST',
          body: unsigned,
          headers: { ...signed(unsigned, 'seven'), 'x-courier-signature': 'invalid' },
        })
      ).status,
    ).toBe(401);
    expect((await send('{"type":"order.shipped"}', 'three')).status).toBe(201);
    expect(await (await send('{"type":"order.shipped"}', 'three')).json()).toEqual({
      received: true,
      duplicate: true,
    });
    expect(filteredCalls).toBe(3);
  });
  it('delivers end to end and retries failed business handlers without premature deduplication', async () => {
    const url = await receiver();
    failOnce = true;
    const service = new CourierService({
      allowHttp: true,
      allowPrivateNetworks: true,
      worker: { enabled: false },
      retry: { initialDelayMs: 1, jitter: 'none' },
    });
    services.push(service);
    const d = await service.enqueue({
      url,
      event: 'order.created',
      payload: { orderId: 1 },
      secret: 'secret',
      auth: { type: 'bearer', token: 'token' },
    });
    await service.runOnce();
    expect((await service.getDelivery(d.id))!.status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.runOnce();
    expect((await service.getDelivery(d.id))!.status).toBe('delivered');
    expect(calls).toBe(2);
    const raw = d.body;
    const retry = await fetch(url, { method: 'POST', body: raw, headers: signed(raw, d.id) });
    expect(((await retry.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(calls).toBe(2);
  });
  it('supports async module configuration and automatic worker startup/shutdown', async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 200, headers: {} });
    const module = await Test.createTestingModule({
      imports: [
        CourierModule.forRootAsync({
          useFactory: async () => ({ transport: { send }, worker: { pollIntervalMs: 5 } }),
        }),
      ],
    }).compile();
    await module.init();
    try {
      const courier = module.get(CourierService);
      const d = await courier.enqueue({ url: 'https://example.com', event: 'test', payload: null });
      await vi.waitFor(async () =>
        expect((await courier.getDelivery(d.id))!.status).toBe('delivered'),
      );
    } finally {
      await module.close();
    }
  });
});
describe('HTTP transport limits', () => {
  async function serve(handler: RequestListener) {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  function transport() {
    const t = new HttpCourierTransport({ allowHttp: true, allowPrivateNetworks: true });
    transports.push(t);
    return t;
  }
  it('does not follow redirects to another destination', async () => {
    let followed = false;
    const url = await serve((req, res) => {
      if (req.url === '/target') followed = true;
      res.writeHead(302, { location: '/target' });
      res.end();
    });
    expect(
      (
        await transport().send({
          url,
          body: '{}',
          headers: {},
          timeoutMs: 1000,
          maxResponseBytes: 100,
        })
      ).statusCode,
    ).toBe(302);
    expect(followed).toBe(false);
  });
  it('rejects DNS answers pointing to private addresses before connecting', async () => {
    const t = new HttpCourierTransport({ allowHttp: true });
    transports.push(t);
    await expect(
      t.send({
        url: 'http://private.test',
        body: '{}',
        headers: {},
        timeoutMs: 1000,
        maxResponseBytes: 100,
      }),
    ).rejects.toThrow('forbidden');
  });
  it('bounds response bytes', async () => {
    const url = await serve((_req, res) => res.end('x'.repeat(1024)));
    await expect(
      transport().send({ url, body: '{}', headers: {}, timeoutMs: 1000, maxResponseBytes: 100 }),
    ).rejects.toThrow('size limit');
  });
  it('times out slow endpoints', async () => {
    const url = await serve(() => {});
    await expect(
      transport().send({ url, body: '{}', headers: {}, timeoutMs: 20, maxResponseBytes: 100 }),
    ).rejects.toThrow();
  });
});

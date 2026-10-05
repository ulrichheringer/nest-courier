import { Controller, Inject, Module, Post, Body } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CourierModule, CourierService, SqliteCourierStore, WebhookReceiver, Json } from '../src';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
@Controller()
class ExampleController {
  constructor(@Inject(CourierService) private readonly courier: CourierService) {}

  @Post('orders')
  async createOrder(@Body() order: Json) {
    // In a real application, use an outbox to coordinate DB commit and publish.
    const deliveries = await this.courier.publish({ event: 'order.created', payload: order });
    return { deliveryIds: deliveries.map((delivery) => delivery.id) };
  }

  @Post('webhooks/orders')
  @WebhookReceiver(() => ({
    secrets: [required('WEBHOOK_SECRET')],
    auth: { type: 'bearer', token: required('WEBHOOK_TOKEN') },
    inbox: { namespace: 'orders-v1' },
  }))
  receiveOrder(@Body() event: Json) {
    // Signature and deduplication have run before this handler.
    return { received: true, event };
  }
}
@Module({
  imports: [
    CourierModule.forRootAsync({
      useFactory: () => ({
        store: new SqliteCourierStore(process.env.COURIER_DATABASE ?? 'courier.db'),
        endpoints: [
          {
            id: 'orders-consumer',
            url: required('WEBHOOK_URL'),
            events: ['order.*'],
            secret: required('WEBHOOK_SECRET'),
            auth: { type: 'bearer', token: required('WEBHOOK_TOKEN') },
          },
        ],
        // These opt-ins are exclusively for this local demo.
        allowHttp: process.env.COURIER_LOCAL_DEMO === 'true',
        allowPrivateNetworks: process.env.COURIER_LOCAL_DEMO === 'true',
      }),
    }),
  ],
  controllers: [ExampleController],
})
class ExampleModule {}
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ExampleModule, { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
if (require.main === module) void bootstrap();

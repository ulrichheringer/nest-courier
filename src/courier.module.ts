import { DynamicModule, Module } from '@nestjs/common';
import { COURIER_OPTIONS } from './config';
import { CourierService } from './courier.service';
import { CourierInboxService } from './inbox.service';
import { CourierWebhookGuard, CourierInboxInterceptor } from './receiver';
import { CourierAsyncOptions, CourierOptions } from './types';
const providers = [
  CourierService,
  CourierInboxService,
  CourierWebhookGuard,
  CourierInboxInterceptor,
];
@Module({})
export class CourierModule {
  static forRoot(options: CourierOptions = {}, global = false): DynamicModule {
    return {
      module: CourierModule,
      global,
      providers: [{ provide: COURIER_OPTIONS, useValue: options }, ...providers],
      exports: providers,
    };
  }
  static forRootAsync(options: CourierAsyncOptions): DynamicModule {
    return {
      module: CourierModule,
      global: options.global,
      imports: options.imports,
      providers: [
        { provide: COURIER_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...providers,
      ],
      exports: providers,
    };
  }
}

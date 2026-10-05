import {
  applyDecorators,
  CallHandler,
  ForbiddenException,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, Observable } from 'rxjs';
import { matchesEvent } from './courier.service';
import { CourierInboxService } from './inbox.service';
import { Auth } from './types';
import { safeEqual, verifyWebhook } from './signature';
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}
export interface ReceiverOptions {
  secrets: string[];
  /** Signed envelope types to accept; supports exact names, prefix.* and *. Omit to accept all. */
  events?: string[];
  auth?: Auth;
  toleranceSeconds?: number;
  maxPayloadBytes?: number;
  inbox?: false | { namespace?: string; ttlMs?: number; leaseMs?: number };
}
export type ReceiverConfiguration =
  ReceiverOptions | ((request: WebhookRequest) => ReceiverOptions | Promise<ReceiverOptions>);
const RECEIVER_OPTIONS = Symbol('RECEIVER_OPTIONS');
const VERIFIED = Symbol('COURIER_VERIFIED');
type VerifiedRequest = WebhookRequest & { [VERIFIED]?: ReceiverOptions };
export function WebhookReceiver(options: ReceiverConfiguration): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(RECEIVER_OPTIONS, options),
    UseGuards(CourierWebhookGuard),
    UseInterceptors(CourierInboxInterceptor),
  );
}
function header(request: WebhookRequest, key: string): string | undefined {
  const value = request.headers[key.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
@Injectable()
export class CourierWebhookGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<ReceiverConfiguration>(RECEIVER_OPTIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!config) throw new UnauthorizedException('Webhook receiver is not configured');
    const request = context.switchToHttp().getRequest<VerifiedRequest>();
    const options = typeof config === 'function' ? await config(request) : config;
    const fail = (): never => {
      throw new UnauthorizedException('Invalid webhook authentication or signature');
    };
    if (
      !Buffer.isBuffer(request.rawBody) ||
      request.rawBody.length > (options.maxPayloadBytes ?? 1_048_576)
    )
      fail();
    const auth = options.auth;
    if (
      auth?.type === 'bearer' &&
      !safeEqual(header(request, 'authorization') ?? '', `Bearer ${auth.token}`)
    )
      fail();
    if (
      auth?.type === 'basic' &&
      !safeEqual(
        header(request, 'authorization') ?? '',
        `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      )
    )
      fail();
    if (auth?.type === 'api-key' && !safeEqual(header(request, auth.header) ?? '', auth.value))
      fail();
    if (
      !verifyWebhook(request.rawBody!, header(request, 'x-courier-signature') ?? '', {
        secrets: options.secrets,
        id: header(request, 'x-courier-id') ?? '',
        toleranceSeconds: options.toleranceSeconds,
      })
    )
      fail();
    if (options.events !== undefined) {
      let event: unknown;
      try {
        event = JSON.parse(request.rawBody!.toString('utf8'));
      } catch {
        throw new ForbiddenException('Webhook event is not accepted');
      }
      const type = event && typeof event === 'object' && 'type' in event ? event.type : undefined;
      if (
        typeof type !== 'string' ||
        !type ||
        !options.events.some((pattern) => matchesEvent(pattern, type))
      )
        throw new ForbiddenException('Webhook event is not accepted');
    }
    request[VERIFIED] = options;
    return true;
  }
}

@Injectable()
export class CourierInboxInterceptor implements NestInterceptor {
  constructor(@Inject(CourierInboxService) private readonly inbox: CourierInboxService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<VerifiedRequest>();
    const options = request[VERIFIED];
    if (!options) throw new UnauthorizedException('Webhook has not been verified');
    if (options.inbox === false) return next.handle();
    return from(
      this.inbox
        .handle(
          {
            namespace:
              options.inbox?.namespace ?? `${context.getClass().name}.${context.getHandler().name}`,
            id: header(request, 'x-courier-id')!,
            ttlMs: options.inbox?.ttlMs,
            leaseMs: options.inbox?.leaseMs,
          },
          () => lastValueFrom(next.handle(), { defaultValue: undefined }),
        )
        .then((result) => (result.duplicate ? { received: true, duplicate: true } : result.value)),
    );
  }
}

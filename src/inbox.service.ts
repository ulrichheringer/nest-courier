import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { CourierService } from './courier.service';
import { positive } from './config';
export interface InboxOptions {
  namespace: string;
  id: string;
  ttlMs?: number;
  leaseMs?: number;
}
export type InboxResult<T> = { duplicate: false; value: T } | { duplicate: true };
@Injectable()
export class CourierInboxService {
  constructor(@Inject(CourierService) private readonly courier: CourierService) {}
  /** Call only after authentication/signature verification. Handler must finish inside leaseMs. */
  async handle<T>(options: InboxOptions, handler: () => Promise<T>): Promise<InboxResult<T>> {
    if (!options.namespace || !options.id)
      throw new Error('Inbox requires namespace and delivery ID');
    const ttl = positive(options.ttlMs ?? 86_400_000, 'inbox ttlMs');
    const lease = positive(options.leaseMs ?? 300_000, 'inbox leaseMs');
    const key = createHash('sha256')
      .update(JSON.stringify([options.namespace, options.id]))
      .digest('hex');
    const token = randomUUID();
    const claim = await this.courier.store.claimReceipt(key, token, Date.now(), lease);
    if (claim === 'duplicate') return { duplicate: true };
    if (claim === 'busy') throw new ConflictException('Webhook is already processing');
    try {
      const value = await handler();
      if (!(await this.courier.store.completeReceipt(key, token, Date.now() + ttl)))
        throw new ConflictException('Webhook processing lease was lost');
      return { duplicate: false, value };
    } catch (error) {
      await this.courier.store.releaseReceipt(key, token);
      throw error;
    }
  }
}

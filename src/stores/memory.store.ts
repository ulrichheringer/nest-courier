import { randomUUID } from 'node:crypto';
import { CourierStore, Delivery, DeliveryQuery, Endpoint } from '../types';

export class MemoryCourierStore implements CourierStore {
  private readonly deliveries = new Map<string, Delivery>();
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly receipts = new Map<
    string,
    { token: string; state: 'processing' | 'done'; expiresAt: number }
  >();
  async putEndpoint(endpoint: Endpoint): Promise<void> {
    this.endpoints.set(endpoint.id, structuredClone(endpoint));
  }
  async listEndpoints(): Promise<Endpoint[]> {
    return structuredClone([...this.endpoints.values()]);
  }
  async removeEndpoint(id: string): Promise<void> {
    this.endpoints.delete(id);
  }
  async enqueue(delivery: Delivery): Promise<Delivery> {
    const existing =
      this.deliveries.get(delivery.id) ??
      (delivery.deduplicationKey
        ? [...this.deliveries.values()].find(
            (d) => d.deduplicationKey === delivery.deduplicationKey,
          )
        : undefined);
    if (existing) return structuredClone(existing);
    this.deliveries.set(delivery.id, structuredClone(delivery));
    return structuredClone(delivery);
  }
  async get(id: string): Promise<Delivery | undefined> {
    const d = this.deliveries.get(id);
    return d ? structuredClone(d) : undefined;
  }
  async list(query: DeliveryQuery = {}): Promise<Delivery[]> {
    return structuredClone(
      [...this.deliveries.values()]
        .filter(
          (d) =>
            (!query.status || d.status === query.status) &&
            (!query.endpointId || d.endpoint.id === query.endpointId),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)),
    );
  }
  async claimDue(now: number, limit: number, leaseMs: number): Promise<Delivery[]> {
    const due = [...this.deliveries.values()]
      .filter(
        (d) =>
          (d.status === 'pending' && d.nextAttemptAt <= now) ||
          (d.status === 'processing' && (d.leaseUntil ?? 0) <= now),
      )
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    for (const d of due) {
      d.status = 'processing';
      d.leaseToken = randomUUID();
      d.leaseUntil = now + leaseMs;
    }
    return structuredClone(due);
  }
  async settle(delivery: Delivery, leaseToken: string): Promise<boolean> {
    const current = this.deliveries.get(delivery.id);
    if (current?.status !== 'processing' || current.leaseToken !== leaseToken) return false;
    const next = structuredClone(delivery);
    delete next.leaseToken;
    delete next.leaseUntil;
    this.deliveries.set(next.id, next);
    return true;
  }
  async cancel(id: string): Promise<boolean> {
    const d = this.deliveries.get(id);
    if (!d || d.status !== 'pending') return false;
    d.status = 'cancelled';
    return true;
  }
  async redrive(id: string, now: number): Promise<boolean> {
    const d = this.deliveries.get(id);
    if (!d || !['dead', 'cancelled'].includes(d.status)) return false;
    d.status = 'pending';
    d.nextAttemptAt = now;
    d.cycleAttempts = 0;
    return true;
  }
  async claimReceipt(
    key: string,
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<'claimed' | 'duplicate' | 'busy'> {
    const current = this.receipts.get(key);
    if (current && current.expiresAt > now) return current.state === 'done' ? 'duplicate' : 'busy';
    this.receipts.set(key, { token, state: 'processing', expiresAt: now + leaseMs });
    return 'claimed';
  }
  async completeReceipt(key: string, token: string, expiresAt: number): Promise<boolean> {
    const current = this.receipts.get(key);
    if (current?.token !== token || current.state !== 'processing') return false;
    this.receipts.set(key, { token, state: 'done', expiresAt });
    return true;
  }
  async releaseReceipt(key: string, token: string): Promise<void> {
    if (this.receipts.get(key)?.token === token) this.receipts.delete(key);
  }
  async prune(before: number): Promise<number> {
    let count = 0;
    for (const [id, d] of this.deliveries)
      if (
        ['delivered', 'dead', 'cancelled'].includes(d.status) &&
        (d.attempts.at(-1)?.startedAt ?? d.createdAt) < before
      ) {
        this.deliveries.delete(id);
        count++;
      }
    for (const [key, receipt] of this.receipts)
      if (receipt.expiresAt < before) this.receipts.delete(key);
    return count;
  }
}

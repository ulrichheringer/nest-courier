import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CourierStore, Delivery, MemoryCourierStore, SqliteCourierStore } from '../src';
function delivery(id = 'one'): Delivery {
  return {
    id,
    eventId: 'event',
    event: 'order.created',
    endpoint: { id: 'endpoint', url: 'https://example.com', events: ['*'] },
    body: '{}',
    status: 'pending',
    createdAt: 1,
    nextAttemptAt: 1,
    attempts: [],
    cycleAttempts: 0,
    deduplicationKey: id,
  };
}
for (const kind of ['memory', 'sqlite'] as const)
  describe(`${kind} store contract`, () => {
    let store: CourierStore;
    afterEach(async () => {
      await store?.close?.();
    });
    function setup(): CourierStore {
      store = kind === 'memory' ? new MemoryCourierStore() : new SqliteCourierStore(':memory:');
      return store;
    }
    it('deduplicates atomically and returns isolated objects', async () => {
      const s = setup();
      await s.enqueue(delivery());
      expect((await s.enqueue({ ...delivery('two'), deduplicationKey: 'one' })).id).toBe('one');
      const result = (await s.get('one'))!;
      result.status = 'dead';
      expect((await s.get('one'))!.status).toBe('pending');
    });
    it('leases exclusively, recovers expired claims and rejects stale acknowledgements', async () => {
      const s = setup();
      await s.enqueue(delivery());
      const [first, second] = await Promise.all([s.claimDue(2, 1, 10), s.claimDue(2, 1, 10)]);
      expect(first.length + second.length).toBe(1);
      const old = [...first, ...second][0]!;
      const reclaimed = (await s.claimDue(12, 1, 10))[0]!;
      expect(reclaimed.leaseToken).not.toBe(old.leaseToken);
      expect(await s.settle({ ...old, status: 'delivered' }, old.leaseToken!)).toBe(false);
      expect(await s.settle({ ...reclaimed, status: 'delivered' }, reclaimed.leaseToken!)).toBe(
        true,
      );
    });
    it('schedules, cancels, redrives and retains history', async () => {
      const s = setup();
      await s.enqueue({ ...delivery(), nextAttemptAt: 100 });
      expect(await s.claimDue(99, 1, 10)).toEqual([]);
      expect(await s.cancel('one')).toBe(true);
      expect(await s.redrive('one', 2)).toBe(true);
      const claimed = (await s.claimDue(2, 1, 10))[0]!;
      expect(await s.cancel('one')).toBe(false);
      const attempt = { number: 1, startedAt: 2, durationMs: 1, statusCode: 400 };
      await s.settle(
        { ...claimed, status: 'dead', attempts: [attempt], cycleAttempts: 1 },
        claimed.leaseToken!,
      );
      expect(await s.redrive('one', 10)).toBe(true);
      expect((await s.get('one'))!.attempts).toEqual([attempt]);
      expect((await s.get('one'))!.cycleAttempts).toBe(0);
    });
    it('supports inbox deduplication, failure release and lease fencing', async () => {
      const s = setup();
      expect(await s.claimReceipt('key', 'a', 0, 10)).toBe('claimed');
      expect(await s.claimReceipt('key', 'b', 1, 10)).toBe('busy');
      expect(await s.claimReceipt('key', 'b', 10, 10)).toBe('claimed');
      expect(await s.completeReceipt('key', 'a', 100)).toBe(false);
      await s.releaseReceipt('key', 'a');
      expect(await s.completeReceipt('key', 'b', 100)).toBe(true);
      expect(await s.claimReceipt('key', 'c', 20, 10)).toBe('duplicate');
      expect(await s.claimReceipt('key', 'c', 100, 10)).toBe('claimed');
      await s.releaseReceipt('key', 'c');
      expect(await s.claimReceipt('key', 'd', 101, 10)).toBe('claimed');
    });
    it('manages endpoints, filters and prunes only terminal work', async () => {
      const s = setup();
      await s.putEndpoint(delivery().endpoint);
      expect(await s.listEndpoints()).toHaveLength(1);
      await s.removeEndpoint('endpoint');
      expect(await s.listEndpoints()).toEqual([]);
      await s.enqueue(delivery());
      await s.enqueue(delivery('two'));
      await s.cancel('two');
      expect(await s.list({ status: 'cancelled', endpointId: 'endpoint' })).toHaveLength(1);
      expect(await s.prune(10)).toBe(1);
      expect(await s.get('one')).toBeDefined();
    });
  });
it('SQLite survives reopen and coordinates independent connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'courier-'));
  const path = join(dir, 'test.db');
  const one = new SqliteCourierStore(path);
  let two: SqliteCourierStore | undefined;
  try {
    await one.enqueue(delivery());
    await one.putEndpoint(delivery().endpoint);
    one.close();
    two = new SqliteCourierStore(path);
    const three = new SqliteCourierStore(path);
    try {
      expect(await two.get('one')).toBeDefined();
      expect(await two.listEndpoints()).toHaveLength(1);
      expect(await two.claimDue(2, 1, 10)).toHaveLength(1);
      expect(await three.claimDue(2, 1, 10)).toHaveLength(0);
      expect(await three.claimDue(12, 1, 10)).toHaveLength(1);
    } finally {
      three.close();
    }
  } finally {
    two?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CourierStore, Delivery, DeliveryQuery, Endpoint } from '../types';

/** Durable local store. Multiple workers must use the same local SQLite file. */
export class SqliteCourierStore implements CourierStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    // Lazy load: memory-only users do not load node:sqlite.
    const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
    this.db = new Database(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS courier_endpoints (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courier_deliveries (
        id TEXT PRIMARY KEY, dedupe TEXT UNIQUE, status TEXT NOT NULL, due INTEGER NOT NULL,
        lease_until INTEGER, lease_token TEXT, endpoint_id TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS courier_due ON courier_deliveries(status, due, lease_until);
      CREATE TABLE IF NOT EXISTS courier_receipts (key TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async putEndpoint(endpoint: Endpoint): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO courier_endpoints VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(endpoint.id, JSON.stringify(endpoint));
  }
  async listEndpoints(): Promise<Endpoint[]> {
    return this.db
      .prepare('SELECT data FROM courier_endpoints ORDER BY id')
      .all()
      .map((r) => JSON.parse(r.data as string) as Endpoint);
  }
  async removeEndpoint(id: string): Promise<void> {
    this.db.prepare('DELETE FROM courier_endpoints WHERE id=?').run(id);
  }
  async enqueue(d: Delivery): Promise<Delivery> {
    return this.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO courier_deliveries VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)',
        )
        .run(
          d.id,
          d.deduplicationKey ?? null,
          d.status,
          d.nextAttemptAt,
          d.endpoint.id,
          d.createdAt,
          JSON.stringify(d),
        );
      const row = this.db
        .prepare('SELECT data FROM courier_deliveries WHERE id=? OR dedupe=? LIMIT 1')
        .get(d.id, d.deduplicationKey ?? null)!;
      return JSON.parse(row.data as string) as Delivery;
    });
  }
  async get(id: string): Promise<Delivery | undefined> {
    const row = this.db.prepare('SELECT data FROM courier_deliveries WHERE id=?').get(id);
    return row ? (JSON.parse(row.data as string) as Delivery) : undefined;
  }
  async list(query: DeliveryQuery = {}): Promise<Delivery[]> {
    return this.db
      .prepare(
        `SELECT data FROM courier_deliveries WHERE (? IS NULL OR status=?) AND (? IS NULL OR endpoint_id=?) ORDER BY created, id LIMIT ? OFFSET ?`,
      )
      .all(
        query.status ?? null,
        query.status ?? null,
        query.endpointId ?? null,
        query.endpointId ?? null,
        query.limit ?? 100,
        query.offset ?? 0,
      )
      .map((r) => JSON.parse(r.data as string) as Delivery);
  }
  async claimDue(now: number, limit: number, leaseMs: number): Promise<Delivery[]> {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT data FROM courier_deliveries WHERE (status='pending' AND due<=?) OR (status='processing' AND lease_until<=?) ORDER BY due LIMIT ?`,
        )
        .all(now, now, limit);
      return rows.map((row) => {
        const d = JSON.parse(row.data as string) as Delivery;
        d.status = 'processing';
        d.leaseToken = randomUUID();
        d.leaseUntil = now + leaseMs;
        this.db
          .prepare(
            'UPDATE courier_deliveries SET status=?, lease_token=?, lease_until=?, data=? WHERE id=?',
          )
          .run(d.status, d.leaseToken, d.leaseUntil, JSON.stringify(d), d.id);
        return d;
      });
    });
  }
  async settle(delivery: Delivery, leaseToken: string): Promise<boolean> {
    const d = structuredClone(delivery);
    delete d.leaseToken;
    delete d.leaseUntil;
    const result = this.db
      .prepare(
        `UPDATE courier_deliveries SET status=?, due=?, lease_token=NULL, lease_until=NULL, data=? WHERE id=? AND status='processing' AND lease_token=?`,
      )
      .run(d.status, d.nextAttemptAt, JSON.stringify(d), d.id, leaseToken);
    return Number(result.changes) === 1;
  }
  private change(id: string, allowed: string[], mutate: (d: Delivery) => void): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM courier_deliveries WHERE id=?').get(id);
      if (!row) return false;
      const d = JSON.parse(row.data as string) as Delivery;
      if (!allowed.includes(d.status)) return false;
      mutate(d);
      this.db
        .prepare('UPDATE courier_deliveries SET status=?, due=?, data=? WHERE id=?')
        .run(d.status, d.nextAttemptAt, JSON.stringify(d), id);
      return true;
    });
  }
  async cancel(id: string): Promise<boolean> {
    return this.change(id, ['pending'], (d) => {
      d.status = 'cancelled';
    });
  }
  async redrive(id: string, now: number): Promise<boolean> {
    return this.change(id, ['dead', 'cancelled'], (d) => {
      d.status = 'pending';
      d.nextAttemptAt = now;
      d.cycleAttempts = 0;
    });
  }
  async claimReceipt(
    key: string,
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<'claimed' | 'duplicate' | 'busy'> {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT state, expires FROM courier_receipts WHERE key=?')
        .get(key);
      if (row && Number(row.expires) > now) return row.state === 'done' ? 'duplicate' : 'busy';
      this.db
        .prepare(
          'INSERT INTO courier_receipts VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,state=excluded.state,expires=excluded.expires',
        )
        .run(key, token, 'processing', now + leaseMs);
      return 'claimed';
    });
  }
  async completeReceipt(key: string, token: string, expiresAt: number): Promise<boolean> {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE courier_receipts SET state='done',expires=? WHERE key=? AND token=? AND state='processing'",
          )
          .run(expiresAt, key, token).changes,
      ) === 1
    );
  }
  async releaseReceipt(key: string, token: string): Promise<void> {
    this.db.prepare('DELETE FROM courier_receipts WHERE key=? AND token=?').run(key, token);
  }
  async prune(before: number): Promise<number> {
    return this.transaction(() => {
      // Latest attempt is persisted in JSON; pending work is never removed.
      const rows = this.db
        .prepare(
          "SELECT id,data FROM courier_deliveries WHERE status IN ('delivered','dead','cancelled')",
        )
        .all();
      let count = 0;
      for (const row of rows) {
        const d = JSON.parse(row.data as string) as Delivery;
        if ((d.attempts.at(-1)?.startedAt ?? d.createdAt) < before) {
          this.db.prepare('DELETE FROM courier_deliveries WHERE id=?').run(row.id!);
          count++;
        }
      }
      this.db.prepare('DELETE FROM courier_receipts WHERE expires<?').run(before);
      return count;
    });
  }
  close(): void {
    this.db.close();
  }
}

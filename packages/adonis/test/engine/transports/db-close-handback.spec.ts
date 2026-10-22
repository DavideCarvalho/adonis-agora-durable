import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeTransportDb } from '../../../src/transports/db-helpers.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';

// A worker closed mid-step (a deploy, a scale-down) kept its rows claimed: they waited out the whole
// lease before another worker could run them, and the takeover then counted toward the poison
// bound, so a long step that spans a few deploys was failed as poison. `close()` now hands every
// still-unfinished claim back after its bounded drain, uncounted; only a worker that dies without
// closing leaves a claim to lapse — and that still counts.

const NAME = 'ext.long';
const TOKEN = sanitizeQueueToken(NAME);
const task = (seq: number): RemoteTask => ({
  runId: 'r1',
  seq,
  stepId: `r1:${seq}`,
  name: NAME,
  group: TOKEN,
  input: { seq },
  attempt: 1,
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('DbTransport close() hand-back', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it('a worker closed mid-step hands the row back: another runs it at once, uncounted', async () => {
    const db = await makeTransportDb();
    cleanups.push(() => db.manager.closeAll());
    const make = (o: Partial<ConstructorParameters<typeof DbTransport>[0]>) => {
      const t = new DbTransport({ db, pollIntervalMs: 5, leaseMs: 60_000, ...o });
      cleanups.push(() => t.close());
      return t;
    };
    await make({}).dispatch(task(1));

    let startedOnA = false;
    const a = make({ instanceId: 'A', closeTimeoutMs: 50 });
    a.handle(NAME, async () => {
      startedOnA = true;
      await new Promise(() => {}); // a step longer than the deploy's drain budget
    });
    await until(() => startedOnA);
    await a.close();

    const [row] = await db.connection().from(TRANSPORT_TABLES.tasks);
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();

    let reclaimsOnB: number | undefined;
    make({ instanceId: 'B' }).handle(NAME, async () => {
      const [r] = await db.connection().from(TRANSPORT_TABLES.tasks).where('step_id', 'r1:1');
      reclaimsOnB = Number(r.reclaims);
      return 'done';
    });
    // Picked up within a poll or two, not after the 60s lease.
    await until(() => reclaimsOnB !== undefined, 1_000);
    expect(reclaimsOnB).toBe(0);
  });

  it('close() also hands back a result batch it was still settling', async () => {
    const db = await makeTransportDb();
    cleanups.push(() => db.manager.closeAll());
    const worker = new DbTransport({ db, pollIntervalMs: 5 });
    cleanups.push(() => worker.close());
    worker.handle(NAME, async (i) => i);
    for (let s = 1; s <= 3; s += 1) await worker.dispatch(task(s));
    await until(async () => (await db.connection().from(TRANSPORT_TABLES.results)).length === 3);

    let settling = false;
    const engine = new DbTransport({ db, pollIntervalMs: 5, leaseMs: 60_000, closeTimeoutMs: 50 });
    engine.onResult(async () => {
      settling = true;
      await new Promise(() => {});
    });
    await until(() => settling);
    await engine.close();
    const rows = await db.connection().from(TRANSPORT_TABLES.results);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.claimed_by === null && r.claimed_at === null)).toBe(true);
  });

  it('a worker that dies without closing still leaves a lapsed claim that counts', async () => {
    const db = await makeTransportDb();
    cleanups.push(() => db.manager.closeAll());
    // Worker A's view of the database, which goes away when A "crashes".
    let crashed = false;
    const dbA = {
      connection: (...args: Parameters<Database['connection']>) => {
        if (crashed) throw new Error('process is gone');
        return db.connection(...args);
      },
    } as unknown as Database;

    let startedOnA = false;
    const a = new DbTransport({ db: dbA, pollIntervalMs: 5, leaseMs: 300, onError: () => {} });
    await a.dispatch(task(1));
    a.handle(NAME, async () => {
      startedOnA = true;
      await new Promise(() => {});
    });
    await until(() => startedOnA);
    // The "crash": A can neither renew nor hand back, and never closes.
    crashed = true;

    let reclaimsOnB: number | undefined;
    const b = new DbTransport({ db, pollIntervalMs: 5, leaseMs: 300 });
    cleanups.push(() => b.close());
    b.handle(NAME, async () => {
      const [r] = await db.connection().from(TRANSPORT_TABLES.tasks).where('step_id', 'r1:1');
      reclaimsOnB = Number(r.reclaims);
      return 'done';
    });
    await until(() => reclaimsOnB !== undefined);
    expect(reclaimsOnB).toBe(1);
  });
});

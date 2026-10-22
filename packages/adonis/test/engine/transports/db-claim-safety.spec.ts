import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeTransportDb } from '../../../src/transports/db-helpers.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';

// The task loop used to claim up to `batchSize` (20) rows at once and run them ONE BY ONE, renewing
// only the row currently running. The rest of the batch kept its claim-time `claimed_at`: when the
// earlier rows outlived `leaseMs`, an idle sibling reclaimed and ran them, and when this worker got
// to them it ran them AGAIN, deleted the row without checking it still held the claim, and wrote a
// second result. These pin the fix: claim only as many rows as there are free slots, renew every
// held claim, and settle a row only while still holding its claim.

const NAME = 'ext.slow';
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

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DbTransport claim safety', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let db: Database;

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    if (db) await db.manager.closeAll();
  });

  function transport(opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {}) {
    const t = new DbTransport({ db, pollIntervalMs: 10, ...opts });
    cleanups.push(() => t.close());
    return t;
  }

  it('a step longer than the lease never makes a sibling double-run the rest of the batch', async () => {
    db = await makeTransportDb();
    const engine = transport({ instanceId: 'engine' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    for (let seq = 1; seq <= 3; seq += 1) await engine.dispatch(task(seq));

    const runs = new Map<number, number>();
    const handler = async (input: unknown) => {
      const { seq } = input as { seq: number };
      runs.set(seq, (runs.get(seq) ?? 0) + 1);
      // The first step outlives the lease; the others are quick.
      if (seq === 1) await sleep(2_500);
      return { seq };
    };

    const a = transport({ instanceId: 'A', leaseMs: 1_500 });
    a.handle(NAME, handler);
    await until(() => runs.get(1) === 1);
    // Only now does a second worker come up: anything A is hoarding goes stale while step 1 runs.
    const b = transport({ instanceId: 'B', leaseMs: 1_500 });
    b.handle(NAME, handler);

    await until(() => results.length >= 3, 8_000);
    // Give a would-be double run time to land.
    await sleep(500);

    expect([...runs.entries()].sort()).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    expect(results.map((r) => r.stepId).sort()).toEqual(['r1:1', 'r1:2', 'r1:3']);
  }, 15_000);

  it('a worker whose claim was taken over mid-step neither deletes the row nor writes a result', async () => {
    db = await makeTransportDb();
    const engine = transport({ instanceId: 'engine' });
    await engine.dispatch(task(1));

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    const worker = transport({ instanceId: 'A' });
    worker.handle(NAME, async () => {
      started = true;
      await gate;
      return 'late';
    });
    await until(() => started);

    // Another worker reclaimed the row meanwhile (this one stalled past its lease).
    await db
      .connection()
      .from(TRANSPORT_TABLES.tasks)
      .where('step_id', 'r1:1')
      .update({ claimed_by: 'B:other', claimed_at: Date.now() });
    release();
    await sleep(200);

    const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].claimed_by).toBe('B:other');
    expect(await db.connection().from(TRANSPORT_TABLES.results).select('*')).toEqual([]);
  });

  it('a slow result handler keeps the rest of its batch: no result is delivered twice', async () => {
    db = await makeTransportDb();
    const worker = transport({ instanceId: 'W' });
    worker.handle(NAME, async (input) => input);
    for (let seq = 1; seq <= 3; seq += 1) await worker.dispatch(task(seq));
    await until(async () => (await db.connection().from(TRANSPORT_TABLES.results)).length === 3);
    await worker.close();

    const delivered: string[] = [];
    const settle = async (r: StepResult) => {
      delivered.push(r.stepId);
      await sleep(400); // each settle outlives the lease
    };
    const a = transport({ instanceId: 'A', leaseMs: 300 });
    a.onResult(settle);
    await until(() => delivered.length === 1);
    const b = transport({ instanceId: 'B', leaseMs: 300 });
    b.onResult(settle);

    await until(() => delivered.length >= 3, 5_000);
    await sleep(1_000);
    expect(delivered.sort()).toEqual(['r1:1', 'r1:2', 'r1:3']);
    expect(await db.connection().from(TRANSPORT_TABLES.results).select('*')).toEqual([]);
  }, 10_000);
});

import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { Heartbeat, RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { makeMemoryDb, makeTransportDb } from '../../../src/transports/db-helpers.js';
import {
  TRANSPORT_TABLES,
  createDurableTransportTables,
} from '../../../src/transports/db-schema.js';
import { DbTransport } from '../../../src/transports/db.js';

// Routing is now BY HANDLER NAME: a dispatched task's `group` is the name's routing token
// (`sanitizeQueueToken(name)`), which is also the token a worker's `handle(name)` claims rows for.
const task = (over: Partial<RemoteTask> = {}): RemoteTask => {
  const name = over.name ?? 'math.double';
  return {
    runId: 'r1',
    seq: 1,
    stepId: 'r1:1',
    name,
    group: sanitizeQueueToken(name),
    input: { n: 21 },
    attempt: 1,
    ...over,
  };
};

async function waitFor(fn: () => Promise<boolean>, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met within budget');
}

describe('DbTransport (unit)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  let db: Database;

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
    if (db) await db.manager.closeAll();
  });

  function transport(
    opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {},
  ): DbTransport {
    const t = new DbTransport({ db, pollIntervalMs: 5, ...opts });
    cleanups.push(() => t.close());
    return t;
  }

  it('dispatch inserts a pending task row (idempotent per stepId)', async () => {
    db = await makeTransportDb();
    const t = transport();
    await t.dispatch(task());
    await t.dispatch(task()); // redelivery — must not duplicate

    const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0].step_id).toBe('r1:1');
    expect(rows[0].claimed_at).toBeNull();
    expect(JSON.parse(rows[0].input)).toEqual({ n: 21 });
  });

  it('two worker instances never double-claim the same task', async () => {
    db = await makeTransportDb();
    const engine = transport();
    // 10 tasks, each a distinct step.
    for (let i = 0; i < 10; i++) {
      await engine.dispatch(task({ seq: i, stepId: `r1:${i}` }));
    }

    const seenA: string[] = [];
    const seenB: string[] = [];
    const workerA = transport({ group: 'math', instanceId: 'A' });
    const workerB = transport({ group: 'math', instanceId: 'B' });
    workerA.handle('math.double', (input) => {
      seenA.push(JSON.stringify(input));
      return { ok: true };
    });
    workerB.handle('math.double', (input) => {
      seenB.push(JSON.stringify(input));
      return { ok: true };
    });

    await waitFor(async () => seenA.length + seenB.length === 10);
    // Every task ran exactly once across the two instances — no double-claim.
    expect(seenA.length + seenB.length).toBe(10);
    const tasksLeft = await db.connection().from(TRANSPORT_TABLES.tasks).count('* as c');
    expect(Number(tasksLeft[0].c)).toBe(0);
  });

  it('delivers a worker result row to the engine onResult handler', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });
    worker.handle('math.double', (input) => {
      const { n } = input as { n: number };
      return { result: n * 2 };
    });

    await engine.dispatch(task());
    await waitFor(async () => results.length === 1);

    expect(results[0]!.status).toBe('completed');
    expect(results[0]!.stepId).toBe('r1:1');
    expect(results[0]!.output).toEqual({ result: 42 });
    // Result row consumed + deleted.
    const left = await db.connection().from(TRANSPORT_TABLES.results).count('* as c');
    expect(Number(left[0].c)).toBe(0);
  });

  it('a thrown handler produces a failed result carrying retryable', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });
    worker.handle('math.double', () => {
      throw Object.assign(new Error('declined'), { retryable: false });
    });

    await engine.dispatch(task());
    await waitFor(async () => results.length === 1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error?.message).toBe('declined');
    expect(results[0]!.error?.retryable).toBe(false);
  });

  it('polls heartbeat rows and delivers them to the engine', async () => {
    db = await makeTransportDb();
    const engine = transport();
    const worker = transport({ group: 'math' });

    const beats: Heartbeat[] = [];
    engine.onHeartbeat(async (b) => {
      beats.push(b);
    });

    const beat: Heartbeat = { runId: 'r1', seq: 1, stepId: 'r1:1', group: 'math' };
    await worker.heartbeat(beat);
    await waitFor(async () => beats.length === 1);

    expect(beats[0]).toEqual(beat);
    const left = await db.connection().from(TRANSPORT_TABLES.heartbeats).count('* as c');
    expect(Number(left[0].c)).toBe(0);
  });

  it('a stale claim is reclaimed after the lease expires', async () => {
    db = await makeTransportDb();
    const engine = transport();
    await engine.dispatch(task());

    // Simulate a crashed claimer: stamp the row with an ancient claim that never got deleted.
    await db
      .connection()
      .from(TRANSPORT_TABLES.tasks)
      .where('step_id', 'r1:1')
      .update({ claimed_by: 'dead', claimed_at: Date.now() - 60_000 });

    const seen: string[] = [];
    const worker = transport({ group: 'math', leaseMs: 1000 });
    worker.handle('math.double', (input) => {
      seen.push(JSON.stringify(input));
      return { ok: true };
    });

    await waitFor(async () => seen.length === 1);
    expect(seen).toHaveLength(1);
  });

  it('publishControl stamps `from` and onControl delivers the message', async () => {
    db = await makeTransportDb();
    const a = transport({ instanceId: 'A' });
    const b = transport({ instanceId: 'B' });
    const got: Array<{ kind: string; from?: string }> = [];
    b.onControl((msg) => got.push(msg));

    await a.publishControl({ kind: 'cancel', runId: 'r1' });
    await waitFor(async () => got.length === 1);
    expect(got[0]!.kind).toBe('cancel');
    expect(got[0]!.from).toBe('A');
  });

  describe('namespace scoping', () => {
    it('stamps `default` on every write when no namespace is set (byte-compatible)', async () => {
      db = await makeTransportDb();
      const t = transport();
      await t.dispatch(task());
      const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('namespace');
      expect(rows).toEqual([{ namespace: 'default' }]);
    });

    it('stamps a non-default namespace on dispatched rows', async () => {
      db = await makeTransportDb();
      const t = transport({ namespace: 'tenant-a' });
      await t.dispatch(task());
      const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('namespace');
      expect(rows).toEqual([{ namespace: 'tenant-a' }]);
    });

    it('two namespaces over ONE table set never cross-claim tasks or cross-deliver results', async () => {
      db = await makeTransportDb();
      const alphaEngine = transport({ namespace: 'alpha' });
      const alphaWorker = transport({ namespace: 'alpha', group: 'math' });
      const betaEngine = transport({ namespace: 'beta' });
      const betaWorker = transport({ namespace: 'beta', group: 'math' });

      const alphaResults: unknown[] = [];
      const betaResults: unknown[] = [];
      const betaSeen: string[] = [];
      alphaEngine.onResult(async (r) => void alphaResults.push(r.output));
      betaEngine.onResult(async (r) => void betaResults.push(r.output));
      alphaWorker.handle('math.double', (input: any) => ({ from: 'alpha', n: input.n * 2 }));
      betaWorker.handle('math.double', () => {
        betaSeen.push('beta'); // must NEVER run for an alpha-dispatched task
        return { from: 'beta' };
      });

      await alphaEngine.dispatch(task({ input: { n: 21 } }));
      await waitFor(async () => alphaResults.length === 1);

      expect(alphaResults).toEqual([{ from: 'alpha', n: 42 }]);
      expect(betaSeen).toEqual([]); // beta's worker never saw alpha's task
      expect(betaResults).toEqual([]); // beta's engine never saw alpha's result
    });

    it('an explicit constructor namespace WINS over a later useNamespace()', async () => {
      db = await makeTransportDb();
      const t = transport({ namespace: 'tenant-a' });
      t.useNamespace('tenant-b'); // ignored — explicit wins
      await t.dispatch(task());
      const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('namespace');
      expect(rows).toEqual([{ namespace: 'tenant-a' }]);
    });

    it('useNamespace() adopts a namespace when none was passed explicitly', async () => {
      db = await makeTransportDb();
      const t = transport();
      t.useNamespace('tenant-b');
      await t.dispatch(task());
      const rows = await db.connection().from(TRANSPORT_TABLES.tasks).select('namespace');
      expect(rows).toEqual([{ namespace: 'tenant-b' }]);
    });

    it('back-fills the namespace column on a legacy (pre-namespace) table and claims its rows', async () => {
      db = makeMemoryDb();
      // Simulate a deployment created before namespaces: a tasks table WITHOUT the namespace column,
      // holding one in-flight legacy row.
      await db.connection().schema.createTable(TRANSPORT_TABLES.tasks, (t) => {
        t.string('step_id').primary();
        t.string('run_id').notNullable();
        t.integer('seq').notNullable();
        t.string('name').notNullable();
        t.string('grp').notNullable();
        t.text('input');
        t.string('traceparent');
        t.text('context');
        t.string('transport');
        t.integer('attempt').notNullable();
        t.string('claimed_by');
        t.bigInteger('claimed_at');
        t.bigInteger('created_at').notNullable();
      });
      await db
        .connection()
        .table(TRANSPORT_TABLES.tasks)
        .insert({
          step_id: 'legacy:1',
          run_id: 'legacy',
          seq: 1,
          name: 'math.double',
          // The routing token a worker serving `math.double` now claims by (name-based).
          grp: 'math.double',
          input: JSON.stringify({ n: 5 }),
          attempt: 1,
          claimed_by: null,
          claimed_at: null,
          created_at: Date.now(),
        });

      // The upgrade path adds the column (default 'default') to the existing table.
      await createDurableTransportTables(db);
      expect(await db.connection().schema.hasColumn(TRANSPORT_TABLES.tasks, 'namespace')).toBe(
        true,
      );
      const [legacy] = await db
        .connection()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', 'legacy:1')
        .select('namespace');
      expect(legacy.namespace).toBe('default');

      // A default worker claims and runs the back-filled legacy row.
      const seen: string[] = [];
      const worker = transport({ group: 'math' });
      worker.handle('math.double', (input: any) => {
        seen.push(JSON.stringify(input));
        return { n: input.n * 2 };
      });
      await waitFor(async () => seen.length === 1);
      expect(seen).toEqual([JSON.stringify({ n: 5 })]);
    });
  });
});

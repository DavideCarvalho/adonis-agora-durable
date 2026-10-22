import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import {
  createDurableTransportTables,
  TRANSPORT_TABLES,
} from '../../../src/transports/db-schema.js';
import { dbBackends } from '../../support/backends.js';

// A task row whose worker died had its lapsed claim taken over by the next poll — forever: a step
// that kills (or wedges) every worker it touches was re-delivered without bound. The tasks table
// now counts takeovers (`reclaims`) and, past `maxStalledCount`, the row is failed into a retryable
// StepResult — the queue transport's poison-job bridge.

const POLL = 5;
const NAME = 'ext.poison';
const TOKEN = sanitizeQueueToken(NAME);

const task = (seq = 3): RemoteTask => ({
  runId: 'r1',
  seq,
  stepId: `r1:${seq}`,
  name: NAME,
  group: TOKEN,
  input: {},
  attempt: 1,
});

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe.each(dbBackends())('on $name', ({ makeMemoryDb, makeTransportDb }) => {
  describe('DbTransport poison-task bridge', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let db: Database;

    afterEach(async () => {
      await Promise.all(cleanups.splice(0).map((c) => c()));
      if (db) await db.manager.closeAll();
    });

    function make(opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {}) {
      const t = new DbTransport({ db, pollIntervalMs: POLL, ...opts });
      cleanups.push(() => t.close());
      return t;
    }

    /** A row a dead worker claimed `reclaims` takeovers ago, its lease long lapsed. */
    async function deadClaim(reclaims: number, seq = 3) {
      await make().dispatch(task(seq));
      await db
        .connection()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', `r1:${seq}`)
        .update({ claimed_by: 'dead:1', claimed_at: 1, reclaims });
    }

    it('counts each takeover of a lapsed claim and still runs the row below the bound', async () => {
      db = await makeTransportDb();
      await deadClaim(0);
      let reclaimsSeen: number | undefined;
      const worker = make();
      worker.handle(NAME, async () => {
        const [row] = await db.connection().from(TRANSPORT_TABLES.tasks).where('step_id', 'r1:3');
        reclaimsSeen = Number(row.reclaims);
        return 'ran';
      });
      await until(async () => (await db.connection().from(TRANSPORT_TABLES.results)).length === 1);
      expect(reclaimsSeen).toBe(1);
      const [result] = await db.connection().from(TRANSPORT_TABLES.results);
      expect(result.status).toBe('completed');
    });

    it('a fresh claim is not a reclaim', async () => {
      db = await makeTransportDb();
      await make().dispatch(task());
      let reclaimsSeen: number | undefined;
      make().handle(NAME, async () => {
        const [row] = await db.connection().from(TRANSPORT_TABLES.tasks).where('step_id', 'r1:3');
        reclaimsSeen = Number(row.reclaims);
        return 'ran';
      });
      await until(() => reclaimsSeen !== undefined);
      expect(reclaimsSeen).toBe(0);
    });

    it('past maxStalledCount the row is deleted and a retryable failed result published, unrun', async () => {
      db = await makeTransportDb();
      await deadClaim(3); // this takeover is the 4th
      const engine = make();
      const results: StepResult[] = [];
      engine.onResult(async (r) => void results.push(r));
      let ran = false;
      make().handle(NAME, async () => {
        ran = true;
        return 'x';
      });
      await until(() => results.length === 1);
      expect(ran).toBe(false);
      expect(results[0]).toEqual({
        runId: 'r1',
        seq: 3,
        stepId: 'r1:3',
        status: 'failed',
        output: undefined,
        error: {
          message: 'remote step worker failed: claim lapsed more than 3 times',
          retryable: true,
        },
        startedAt: undefined,
        events: undefined,
      });
      expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
      // The engine's retry re-dispatches the same step id: a fresh row, counted from zero.
      await engine.dispatch(task());
      const [row] = await db.connection().from(TRANSPORT_TABLES.tasks).select('*');
      expect(Number(row.reclaims)).toBe(0);
    });

    it('honours a custom maxStalledCount', async () => {
      db = await makeTransportDb();
      await deadClaim(0);
      const engine = make();
      const results: StepResult[] = [];
      engine.onResult(async (r) => void results.push(r));
      make({ maxStalledCount: 0 }).handle(NAME, async () => 'x');
      await until(() => results.length === 1);
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toMatchObject({ retryable: true });
    });

    it('back-fills `reclaims` on a legacy tasks table (autoCreate) and counts from zero', async () => {
      db = await makeMemoryDb();
      await db.connection().schema.createTable(TRANSPORT_TABLES.tasks, (t) => {
        t.string('step_id').primary();
        t.string('run_id').notNullable();
        t.integer('seq').notNullable();
        t.string('name').notNullable();
        t.string('grp').notNullable();
        t.string('namespace').notNullable().defaultTo('default');
        t.text('input');
        t.string('traceparent');
        t.text('context');
        t.string('transport');
        t.integer('attempt').notNullable();
        t.string('claimed_by');
        t.bigInteger('claimed_at');
        t.bigInteger('created_at').notNullable();
      });
      await db.connection().table(TRANSPORT_TABLES.tasks).insert({
        step_id: 'r1:3',
        run_id: 'r1',
        seq: 3,
        name: NAME,
        grp: TOKEN,
        input: '{}',
        attempt: 1,
        created_at: Date.now(),
      });
      await createDurableTransportTables(db);
      expect(await db.connection().schema.hasColumn(TRANSPORT_TABLES.tasks, 'reclaims')).toBe(true);
      const [row] = await db.connection().from(TRANSPORT_TABLES.tasks);
      expect(Number(row.reclaims)).toBe(0);
    });

    it('without the column (autoCreate off) tasks still run; the bound is off, said once', async () => {
      db = await makeMemoryDb();
      await createDurableTransportTables(db);
      await db.connection().schema.alterTable(TRANSPORT_TABLES.tasks, (t) => {
        t.dropColumn('reclaims');
      });
      const errors: unknown[] = [];
      const engine = make({ autoCreate: false, onError: (e) => errors.push(e) });
      const results: StepResult[] = [];
      engine.onResult(async (r) => void results.push(r));
      await engine.dispatch(task(1));
      await engine.dispatch(task(2));
      await db
        .connection()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', 'r1:2')
        .update({ claimed_by: 'dead:1', claimed_at: 1 });
      make({ autoCreate: false, onError: (e) => errors.push(e) }).handle(NAME, async () => 'ok');
      await until(() => results.length === 2);
      expect(results.every((r) => r.status === 'completed')).toBe(true);
      const warnings = errors.filter((e) => String(e).includes('"reclaims" column'));
      expect(warnings).toHaveLength(1);
    });
  });
});

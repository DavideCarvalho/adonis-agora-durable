import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult, WorkerStatus } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { dbBackends } from '../../support/backends.js';

// The db task loop ran one row at a time with no way to raise it, and claimed 20 rows per poll
// whatever it could run. These cover the slot loop (one poll loop, N slots, claiming only free
// slots), the shared adaptive controller, `resultConcurrency`, and idle backoff.

const POLL = 5;
const NAME = 'ext.work';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe.each(dbBackends())('on $name', ({ makeTransportDb }) => {
  describe('DbTransport concurrency', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let db: Database;

    afterEach(async () => {
      await Promise.all(cleanups.splice(0).map((c) => c()));
      if (db) await db.manager.closeAll();
    });

    function make(opts: Partial<ConstructorParameters<typeof DbTransport>[0]> = {}) {
      const t = new DbTransport({ db, pollIntervalMs: POLL, workerKeysCacheMs: 0, ...opts });
      cleanups.push(() => t.close());
      return t;
    }

    /** Counts SELECTs against `table` (each claim round starts with one). SQLite quotes identifiers
     *  with backticks, Postgres with double quotes. */
    function countSelects(table: string): () => number {
      let n = 0;
      db.connection()
        .getWriteClient()
        .on('query', (q: { sql: string }) => {
          if (
            q.sql.startsWith('select') &&
            (q.sql.includes(`from \`${table}\``) || q.sql.includes(`from "${table}"`))
          )
            n += 1;
        });
      return () => n;
    }

    async function peakInFlight(concurrency: number | undefined, jobs: number) {
      db = await makeTransportDb();
      const engine = make();
      const results: StepResult[] = [];
      engine.onResult(async (r) => void results.push(r));
      let running = 0;
      let peak = 0;
      let peakClaimed = 0;
      const worker = make(concurrency === undefined ? {} : { concurrency });
      worker.handle(NAME, async (input) => {
        running += 1;
        peak = Math.max(peak, running);
        const claimed = await db
          .connection()
          .from(TRANSPORT_TABLES.tasks)
          .whereNotNull('claimed_by')
          .count('* as n');
        peakClaimed = Math.max(peakClaimed, Number(claimed[0].n));
        await sleep(30);
        running -= 1;
        return input;
      });
      for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
      await until(() => results.length === jobs);
      return { peak, peakClaimed, results };
    }

    it('runs one row at a time by default, and claims only that one', async () => {
      const { peak, peakClaimed } = await peakInFlight(undefined, 4);
      expect(peak).toBe(1);
      expect(peakClaimed).toBe(1);
    });

    it('runs up to `concurrency` rows at once and never claims more than its free slots', async () => {
      const { peak, peakClaimed, results } = await peakInFlight(3, 10);
      expect(peak).toBe(3);
      expect(peakClaimed).toBeLessThanOrEqual(3);
      expect(results.every((r) => r.status === 'completed')).toBe(true);
      expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
    });

    it('a non-finite concurrency falls back to one slot', async () => {
      const { peak } = await peakInFlight(Number.NaN, 3);
      expect(peak).toBe(1);
    });

    it('more slots do not add polling: an idle worker polls the same with 1 or 8 slots', async () => {
      db = await makeTransportDb();
      const polls = countSelects(TRANSPORT_TABLES.tasks);
      const one = make({ concurrency: 1, idleBackoffMax: 1 });
      one.handle(NAME, async () => 'x');
      // A window wide enough for a handful of polls against a real database on a loaded machine.
      await sleep(300);
      await one.close();
      const withOne = polls();
      const eight = make({ concurrency: 8, idleBackoffMax: 1 });
      eight.handle(NAME, async () => 'x');
      await sleep(300);
      await eight.close();
      const withEight = polls() - withOne;
      expect(withOne).toBeGreaterThan(5);
      expect(withEight).toBeLessThan(withOne * 2);
    });

    it('an idle task loop backs off; the results loop never does', async () => {
      db = await makeTransportDb();
      const taskPolls = countSelects(TRANSPORT_TABLES.tasks);
      const resultPolls = countSelects(TRANSPORT_TABLES.results);
      const t = make({ idleBackoffMax: 8 });
      t.handle(NAME, async () => 'x');
      t.onResult(async () => {});
      await sleep(250);
      expect(resultPolls()).toBeGreaterThan(taskPolls() * 2);
    });

    it('settles up to `resultConcurrency` results at once (default one)', async () => {
      const peakWith = async (resultConcurrency: number | undefined) => {
        db = await makeTransportDb();
        const worker = make();
        worker.handle(NAME, async (input) => input);
        for (let i = 1; i <= 6; i += 1) await worker.dispatch(task(i));
        await until(async () => (await db.connection().from(TRANSPORT_TABLES.tasks)).length === 0);
        let running = 0;
        let peak = 0;
        let settled = 0;
        const engine = make(resultConcurrency === undefined ? {} : { resultConcurrency });
        engine.onResult(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await sleep(20);
          running -= 1;
          settled += 1;
        });
        await until(() => settled === 6);
        await Promise.all(cleanups.splice(0).map((c) => c()));
        await db.manager.closeAll();
        return peak;
      };
      expect(await peakWith(undefined)).toBe(1);
      expect(await peakWith(3)).toBe(3);
    });

    it('stop() waits for every in-flight slot, and their results are written', async () => {
      db = await makeTransportDb();
      let started = 0;
      const worker = new DbTransport({ db, pollIntervalMs: POLL, concurrency: 3 });
      worker.handle(NAME, async (input) => {
        started += 1;
        await sleep(60);
        return input;
      });
      for (let i = 1; i <= 3; i += 1) await worker.dispatch(task(i));
      await until(() => started === 3);
      await worker.stop();
      expect(await db.connection().from(TRANSPORT_TABLES.results).select('*')).toHaveLength(3);
      expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
    });

    describe('adaptive', () => {
      async function statusOf(t: DbTransport): Promise<WorkerStatus | undefined> {
        return (await t.groupHealth(TOKEN)).liveWorkers[0]?.status;
      }

      function workerWith(extra: Parameters<typeof make>[0], stepMs: number) {
        const worker = make(extra);
        const stats = { running: 0, peak: 0 };
        worker.handle(NAME, async (input) => {
          stats.running += 1;
          stats.peak = Math.max(stats.peak, stats.running);
          await sleep(stepMs);
          stats.running -= 1;
          return input;
        });
        return stats;
      }

      it('grows the slot count while steps saturate the limit at a steady latency', async () => {
        db = await makeTransportDb();
        const engine = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        const stats = workerWith(
          {
            workerHeartbeatIntervalMs: 10,
            concurrency: { mode: 'adaptive', min: 1, max: 4, start: 1, tickMs: 15 },
          },
          25,
        );
        const jobs = 40;
        for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
        await until(() => results.length === jobs, 10_000);
        expect(stats.peak).toBeGreaterThan(1);
        expect(stats.peak).toBeLessThanOrEqual(4);
        await until(async () => (await statusOf(engine))?.lastAdjust !== undefined);
        const status = await statusOf(engine);
        expect(status?.concurrency).toMatchObject({ mode: 'adaptive', min: 1, max: 4 });
        // It grew (the peak above, from a start of 1). Its latest move is that growth — or, when the
        // step latency it measures rose as it grew (a loaded machine, a real database), a
        // backpressure step back from it.
        expect(['grow', 'backpressure']).toContain(status?.lastAdjust?.reason);
      });

      it('shrinks the live limit under the RAM brake, and the slot loop obeys it', async () => {
        db = await makeTransportDb();
        const engine = make();
        const results: StepResult[] = [];
        engine.onResult(async (r) => void results.push(r));
        const stats = workerWith(
          {
            workerHeartbeatIntervalMs: 5,
            concurrency: {
              mode: 'adaptive',
              min: 1,
              max: 4,
              start: 4,
              tickMs: 10,
              ramCeilingPct: 1e-4,
            },
          },
          20,
        );
        await until(async () => (await statusOf(engine))?.concurrency.limit === 1);
        for (let i = 1; i <= 6; i += 1) await engine.dispatch(task(i));
        await until(() => results.length === 6);
        expect(stats.peak).toBe(1);
      });
    });
  });
});

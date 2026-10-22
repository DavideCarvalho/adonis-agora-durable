import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask, StepResult, WorkerStatus } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makePostgresDb } from '../../../src/transports/db-helpers.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { lucidWorkerKeys } from '../../../src/transports/worker-keys-db.js';
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

async function until(
  cond: () => boolean | Promise<boolean>,
  budgetMs = 20_000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe.each(dbBackends())('on $name', ({ name: backendName, makeTransportDb }) => {
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

    /** Counts SELECTs against `table` (each claim round starts with one), optionally only those bound
     *  to routing token `grp`. SQLite quotes identifiers with backticks, Postgres with double quotes. */
    function countSelects(table: string, grp?: string): () => number {
      let n = 0;
      db.connection()
        .getWriteClient()
        .on('query', (q: { sql: string; bindings?: unknown[] }) => {
          if (
            q.sql.startsWith('select') &&
            (q.sql.includes(`from \`${table}\``) || q.sql.includes(`from "${table}"`)) &&
            (grp === undefined || (q.bindings ?? []).includes(grp))
          )
            n += 1;
        });
      return () => n;
    }

    /**
     * Run `jobs` steps on a worker with `concurrency` slots; report how many ran at once and how many
     * rows were claimed at once. Every row is dispatched BEFORE the worker starts, and each step holds
     * its slot until `expected` steps are running together (bounded): how many run at once then
     * depends on the slot loop alone, not on whether dispatches and 30ms sleeps happened to overlap
     * on a loaded machine. A slot loop that over-runs still shows it — the barrier never caps `peak`.
     */
    async function peakInFlight(concurrency: number | undefined, jobs: number, expected: number) {
      db = await makeTransportDb();
      const engine = make();
      const results: StepResult[] = [];
      engine.onResult(async (r) => void results.push(r));
      for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
      let running = 0;
      let peak = 0;
      let peakClaimed = 0;
      let done = 0;
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
        // Hold the slot until the expected company arrives (or the rest of the backlog is running).
        await until(() => running >= Math.min(expected, jobs - done), 3000).catch(() => undefined);
        await sleep(30);
        running -= 1;
        done += 1;
        return input;
      });
      await until(() => results.length === jobs, 60_000);
      return { peak, peakClaimed, results };
    }

    it('runs one row at a time by default, and claims only that one', async () => {
      const { peak, peakClaimed } = await peakInFlight(undefined, 4, 1);
      expect(peak).toBe(1);
      expect(peakClaimed).toBe(1);
    });

    it('runs up to `concurrency` rows at once and never claims more than its free slots', async () => {
      const { peak, peakClaimed, results } = await peakInFlight(3, 10, 3);
      expect(peak).toBe(3);
      expect(peakClaimed).toBeLessThanOrEqual(3);
      expect(results.every((r) => r.status === 'completed')).toBe(true);
      expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
    });

    it('a non-finite concurrency falls back to one slot', async () => {
      const { peak } = await peakInFlight(Number.NaN, 3, 1);
      expect(peak).toBe(1);
    });

    it('more slots do not add polling: an idle worker polls the same with 1 or 8 slots', async () => {
      db = await makeTransportDb();
      // Side by side over the same window (each on its own routing token, told apart by the claim's
      // bindings), so a loaded machine slows both equally instead of skewing one fixed-length window
      // against the other.
      const one = make({ concurrency: 1, idleBackoffMax: 1 });
      const eight = make({ concurrency: 8, idleBackoffMax: 1 });
      const withOne = countSelects(TRANSPORT_TABLES.tasks, sanitizeQueueToken('ext.one'));
      const withEight = countSelects(TRANSPORT_TABLES.tasks, sanitizeQueueToken('ext.eight'));
      one.handle('ext.one', async () => 'x');
      eight.handle('ext.eight', async () => 'x');
      // Counted from the moment both poll: a worker that came up later (its first round's schema
      // probes) would otherwise lose a head start worth dozens of 5ms rounds.
      await until(() => withOne() >= 1 && withEight() >= 1);
      const [oneAt, eightAt] = [withOne(), withEight()];
      await until(() => withOne() - oneAt >= 40);
      const [polledOne, polledEight] = [withOne() - oneAt, withEight() - eightAt];
      await Promise.all([one.close(), eight.close()]);
      // One loop per worker whatever its slots: eight slots polling on their own would be ~8×.
      expect(polledEight).toBeLessThan(polledOne * 2);
    });

    it('an idle task loop backs off; the results loop never does', async () => {
      db = await makeTransportDb();
      const taskPolls = countSelects(TRANSPORT_TABLES.tasks);
      const resultPolls = countSelects(TRANSPORT_TABLES.results);
      // Backing off to 32 × 5ms = 160ms between idle task rounds, against 5ms for results: the ratio
      // stays far above 2 even when every round trip costs tens of milliseconds on a loaded machine.
      const t = make({ idleBackoffMax: 32 });
      t.handle(NAME, async () => 'x');
      t.onResult(async () => {});
      // Counted, not timed: enough result rounds for the task loop to have reached its ceiling.
      await until(() => resultPolls() >= 80);
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
        const expected = resultConcurrency ?? 1;
        engine.onResult(async () => {
          running += 1;
          peak = Math.max(peak, running);
          // Hold the slot until the expected company arrives (bounded), as in peakInFlight.
          await until(() => running >= Math.min(expected, 6 - settled), 3000).catch(
            () => undefined,
          );
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
        // Shaped so a loaded machine cannot starve the growth signal. The backlog is queued before the
        // worker starts, so the slot is busy at every tick (saturated). Steps are long next to the
        // timer jitter of a busy event loop, so their latency reads as steady (the gradient that
        // gates growth compares the median step to the fastest, and 10ms of lag on a 25ms step read
        // as queuing). The tick outlasts a step, so a busy slot always completes within two ticks —
        // two ticks without a completion read as a stall (backpressure, which only ever sheds).
        const jobs = 20;
        for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
        const stats = workerWith(
          {
            workerHeartbeatIntervalMs: 10,
            concurrency: { mode: 'adaptive', min: 1, max: 4, start: 1, tickMs: 300 },
          },
          200,
        );
        await until(() => results.length === jobs, 60_000);
        // It grew, and the slot loop followed: only a `grow` raises the limit above its start of 1.
        expect(stats.peak).toBeGreaterThan(1);
        expect(stats.peak).toBeLessThanOrEqual(4);
        await until(async () => (await statusOf(engine))?.lastAdjust !== undefined);
        const status = await statusOf(engine);
        expect(status?.concurrency).toMatchObject({ mode: 'adaptive', min: 1, max: 4 });
        // The heartbeat carries the controller's latest move. Which move that is depends on the step
        // latency it measured as it grew — on a loaded machine a step back from the growth is as
        // legitimate as the growth itself — so only its presence is pinned here; the decision rules
        // are unit-tested on the controller with a fake clock.
        expect(status?.lastAdjust?.reason).toBeDefined();
      }, 90_000);

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
      }, 90_000);

      // The race behind the flake above: a round sizes its claim from the limit it read BEFORE the
      // claim's round trips, and the RAM brake fires on its own timer. A claim still in flight when
      // the limit drops used to run every row it won — 2 at once under a live limit of 1. Postgres
      // only: an exclusive table lock is what holds the claim open deterministically.
      it.runIf(backendName === 'postgres')(
        'a claim in flight when the limit drops runs no more rows than the new limit',
        async () => {
          db = await makeTransportDb();
          const engine = make();
          const results: StepResult[] = [];
          engine.onResult(async (r) => void results.push(r));
          // Parked under a group nobody serves; handed to the worker's group while its claim waits.
          for (let i = 1; i <= 2; i += 1) await engine.dispatch({ ...task(i), group: 'parked' });

          // Under the brake only once flipped: the controller reads RSS at every tick.
          let braked = false;
          const realMemoryUsage = process.memoryUsage.bind(process);
          const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
            ...realMemoryUsage(),
            rss: braked ? Number.MAX_SAFE_INTEGER : 1,
          }));
          let claims = 0;
          db.connection()
            .getWriteClient()
            .on('query', (q: { sql: string }) => {
              if (
                q.sql.startsWith('select') &&
                q.sql.includes(`from "${TRANSPORT_TABLES.tasks}"`)
              ) {
                claims += 1;
              }
            });
          let release: () => void = () => {};
          const released = new Promise<void>((r) => {
            release = r;
          });
          let locked: () => void = () => {};
          const isLocked = new Promise<void>((r) => {
            locked = r;
          });
          let lock: Promise<void> | undefined;
          let probe: Database | undefined;
          try {
            const stats = workerWith(
              {
                workerHeartbeatIntervalMs: 5,
                concurrency: {
                  mode: 'adaptive',
                  min: 1,
                  max: 2,
                  start: 2,
                  tickMs: 10,
                  ramCeilingPct: 50,
                },
              },
              50,
            );
            // One idle round first, so the worker's schema probes are behind it.
            await until(() => claims > 0, 20_000, 'an idle round');
            lock = db.connection().transaction(async (trx) => {
              await trx.rawQuery(`lock table "${TRANSPORT_TABLES.tasks}" in access exclusive mode`);
              locked();
              await released;
              await trx.from(TRANSPORT_TABLES.tasks).update({ grp: TOKEN });
            });
            await isLocked;
            // The next round's claim: sized for a limit of 2, now waiting on the lock. Seen from the
            // server (a statement can queue behind the LOCK before the test learns it was granted, so
            // counting statements sent cannot tell), on a connection of its own: the shared pool is
            // partly held by the lock and the blocked claim.
            const schema = (db as Database & { schemaName: string }).schemaName;
            probe = makePostgresDb(process.env.DURABLE_PG_URL as string, schema, 1);
            const waiting = async (): Promise<boolean> => {
              const { rows } = (await (probe as Database).rawQuery(
                `select count(*)::int as n from pg_locks l
                   join pg_class c on c.oid = l.relation
                   join pg_namespace ns on ns.oid = c.relnamespace
                  where not l.granted and c.relname = ? and ns.nspname = ?`,
                [TRANSPORT_TABLES.tasks, schema],
              )) as { rows: Array<{ n: number }> };
              return (rows[0]?.n ?? 0) > 0;
            };
            await until(waiting, 20_000, 'a claim blocked on the lock');
            braked = true;
            // floor(2 × 0.8) = 1: one braked tick takes the live limit to 1, published by heartbeat
            // (read from the keys table: `groupHealth` counts the locked tasks table).
            const keys = lucidWorkerKeys(probe, { autoCreate: false });
            await until(
              async () =>
                (await keys.live(Date.now())).some(
                  ({ value }) => JSON.parse(value).status?.concurrency?.limit === 1,
                ),
              20_000,
              'the braked limit in a heartbeat',
            );
            release();
            await lock;
            await until(() => results.length === 2, 20_000, 'both results');
            expect(results.every((r) => r.status === 'completed')).toBe(true);
            expect(stats.peak).toBe(1);
          } finally {
            release();
            await lock?.catch(() => undefined);
            await probe?.manager.closeAll();
            memory.mockRestore();
          }
        },
        90_000,
      );
    });
  });
});

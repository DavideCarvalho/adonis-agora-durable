import { describe, expect, it } from 'vitest';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { backendUrl } from '../../support/backends.js';
import {
  distinctResults,
  scenarioHarness,
  task,
  until,
} from '../../support/db-scenario-harness.js';

/**
 * The db transport with REAL worker processes on a real Postgres that die (SIGKILL, like a crash or
 * an OOM kill) or are stopped (SIGTERM, like a deploy), and that boot together on an empty schema.
 * Each scenario was first proven by hand against Postgres 16; these keep it proven on every PR. The
 * worker process is `test/support/db-scenario-worker.ts`; it records every run of the step in a
 * table BEFORE the step body, so a run is counted even when its process dies mid-step.
 *
 * Postgres only (`DURABLE_PG_URL`; required in CI): the in-process suites cover the same logic on
 * SQLite too (with a simulated crash), but only a real process can die holding a claim.
 */
const PG_URL = backendUrl('DURABLE_PG_URL');

describe.skipIf(!PG_URL)(
  'DbTransport crash, deploy and boot across real worker processes (Postgres)',
  () => {
    const { setup, emptyDb, spawn, spawnReady, runs, cleanups } = scenarioHarness(PG_URL as string);

    it('(c) a SIGKILLed worker holding rows: each is taken over after the lease, reclaims = 1', async () => {
      const { engine, results } = await setup();
      const leaseMs = 1_500;
      for (let seq = 1; seq <= 3; seq += 1) {
        await engine.dispatch(task(seq, { ms: 50, msOn: { A: 60_000 } }));
      }
      const a = await spawnReady({ role: 'worker', instanceId: 'A', concurrency: 3, leaseMs });
      await until(async () => (await runs()).length === 3, 10_000, 'A to start 3 steps');
      const startedOnA = Math.max(...(await runs()).map((r) => Number(r.at)));
      a.proc.kill('SIGKILL');
      expect((await a.exited).signal).toBe('SIGKILL');
      await spawnReady({ role: 'worker', instanceId: 'B', concurrency: 3, leaseMs });

      await until(() => distinctResults(results) === 3, 15_000, '3 results after the takeover');
      const onB = (await runs()).filter((r) => r.instance === 'B');
      expect(onB.map((r) => r.step_id).sort()).toEqual(['r1:1', 'r1:2', 'r1:3']);
      // A takeover of a lapsed claim, counted toward the poison bound.
      expect(onB.map((r) => r.reclaims)).toEqual([1, 1, 1]);
      // Not before A's lease ran out: the row stayed A's while its claim could still be renewed.
      for (const r of onB) expect(Number(r.at) - startedOnA).toBeGreaterThanOrEqual(leaseMs - 100);
      expect(results.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    }, 30_000);

    it('(d) a step that kills every worker is bridged as poison after maxStalledCount (3)', async () => {
      const { db, engine, results } = await setup();
      await engine.dispatch(task(1, { die: true }));
      const worker = { concurrency: 1, leaseMs: 800, pollIntervalMs: 20, maxStalledCount: 3 };
      let spawned = 0;
      // Keep a worker alive: each one that picks the step up dies on it, and is replaced.
      while (results.length === 0 && spawned < 8) {
        spawned += 1;
        const child = await spawnReady({ role: 'worker', instanceId: `W${spawned}`, ...worker });
        await Promise.race([child.exited, until(() => results.length > 0, 10_000).catch(() => {})]);
      }
      await until(() => results.length > 0, 10_000, 'the poison result');

      // The first claim and three takeovers each ran it (and died); the fourth takeover bridges it.
      expect((await runs()).map((r) => r.reclaims)).toEqual([0, 1, 2, 3]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stepId: 'r1:1',
        status: 'failed',
        error: { retryable: true, message: expect.stringContaining('lapsed more than 3 times') },
      });
      expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
    }, 45_000);

    it('(f) SIGTERM hands a claim back at once (reclaims 0); SIGKILL waits out the lease and counts', async () => {
      const { engine, results } = await setup();
      const leaseMs = 4_000;
      const long = { ms: 20, msOn: { A: 60_000, C: 60_000 } };

      // A deploy: A is told to stop mid-step and hands the row back on its way out.
      await engine.dispatch(task(1, long));
      const a = await spawnReady({ role: 'worker', instanceId: 'A', leaseMs, closeTimeoutMs: 100 });
      await until(async () => (await runs()).some((r) => r.instance === 'A'), 10_000, 'A to start');
      a.proc.kill('SIGTERM');
      expect(await a.exited).toEqual({ code: 0, signal: null });
      const termAt = Date.now();
      const b = await spawnReady({ role: 'worker', instanceId: 'B', leaseMs });
      await until(
        () => results.some((r) => r.stepId === 'r1:1'),
        10_000,
        'r1:1 handed back and run',
      );
      const onB = (await runs()).find((r) => r.instance === 'B');
      expect(onB).toMatchObject({ step_id: 'r1:1', reclaims: 0 });
      // Picked up at once, not after A's lease.
      expect(Number(onB?.at) - termAt).toBeLessThan(leaseMs);
      b.proc.kill('SIGTERM');
      await b.exited;

      // A crash: C dies holding a row, which waits out the lease and counts as a reclaim.
      await engine.dispatch(task(2, long));
      const c = await spawnReady({ role: 'worker', instanceId: 'C', leaseMs });
      await until(async () => (await runs()).some((r) => r.instance === 'C'), 10_000, 'C to start');
      const startedOnC = Number((await runs()).find((r) => r.instance === 'C')?.at);
      c.proc.kill('SIGKILL');
      await c.exited;
      await spawnReady({ role: 'worker', instanceId: 'D', leaseMs });
      await until(
        () => results.some((r) => r.stepId === 'r1:2'),
        15_000,
        'r1:2 taken over and run',
      );
      const takeover = (await runs()).find((r) => r.instance === 'D');
      expect(takeover).toMatchObject({ step_id: 'r1:2', reclaims: 1 });
      expect(Number(takeover?.at) - startedOnC).toBeGreaterThanOrEqual(leaseMs - 100);
    }, 45_000);

    it('(g) four processes creating the tables at once on an empty schema all succeed', async () => {
      const db = await emptyDb();
      const creators = Array.from({ length: 4 }, (_, i) =>
        spawn({ role: 'schema', instanceId: `S${i}` }),
      );
      await until(
        () => creators.every((c) => c.messages.some((m) => m.ready)),
        15_000,
        'creators ready',
      );
      // Several rounds, each on a fresh empty schema, all four released at once.
      for (let round = 0; round < 3; round += 1) {
        const schema = `${db.schemaName}_${round}`;
        await db.rawQuery(`create schema "${schema}"`);
        cleanups.push(async () => void (await db.rawQuery(`drop schema "${schema}" cascade`)));
        for (const c of creators) c.proc.send({ go: schema });
        await until(
          () => creators.every((c) => c.messages.some((m) => m.done === schema)),
          15_000,
          `round ${round} done`,
        );
        const outcomes = creators.map((c) => c.messages.find((m) => m.done === schema));
        expect(outcomes, `round ${round}`).toEqual(
          creators.map(() => expect.objectContaining({ ok: true })),
        );
        const { rows } = (await db.rawQuery(
          'select table_name from information_schema.tables where table_schema = ? order by 1',
          [schema],
        )) as { rows: Array<{ table_name: string }> };
        expect(rows.map((r) => r.table_name)).toEqual(
          expect.arrayContaining(Object.values(TRANSPORT_TABLES)),
        );
      }
      for (const c of creators) c.proc.send({ exit: true });
    }, 60_000);
  },
);

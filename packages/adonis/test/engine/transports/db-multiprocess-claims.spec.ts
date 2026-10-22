import { describe, expect, it } from 'vitest';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { backendUrl } from '../../support/backends.js';
import {
  distinctResults,
  runsPerStep,
  scenarioHarness,
  sleep,
  task,
  until,
} from '../../support/db-scenario-harness.js';

/**
 * The db transport's claim guarantees with REAL worker processes on a real Postgres: separate
 * processes (each with its own pool) contending for the same rows. Each scenario was first proven by
 * hand against Postgres 16; these keep it proven on every PR. The worker process is
 * `test/support/db-scenario-worker.ts`; it records every run of the step in a table, so a run is
 * counted even when its process dies mid-step. Crash/deploy scenarios: `db-multiprocess-crash`.
 *
 * Postgres only (`DURABLE_PG_URL`; required in CI): the in-process suites cover the same logic on
 * SQLite too, but cross-process contention is what a production fleet does.
 */
const PG_URL = backendUrl('DURABLE_PG_URL');

describe.skipIf(!PG_URL)('DbTransport claims across real worker processes (Postgres)', () => {
  const { setup, spawnReady, runs } = scenarioHarness(PG_URL as string);

  // The pre-fix task loop claimed a batch of 20 and ran it one row at a time, renewing only the row
  // in hand: B reclaimed A's stale rows and ran them, then A ran them again — steps 2–6 twice each.
  it('(a) a 4s step under a 1s lease, 2 workers × 3 slots: each of 6 steps runs exactly once', async () => {
    const { engine, results } = await setup();
    for (let seq = 1; seq <= 6; seq += 1) await engine.dispatch(task(seq, { ms: 4_000 }));
    const worker = { concurrency: 3, leaseMs: 1_000, pollIntervalMs: 50 };
    await spawnReady({ role: 'worker', instanceId: 'A', ...worker });
    // Only once A is busy does B come up: whatever A holds beyond its running steps goes stale.
    await until(async () => (await runs()).length > 0, 10_000, 'A to start a step');
    await spawnReady({ role: 'worker', instanceId: 'B', ...worker });

    await until(() => distinctResults(results) === 6, 25_000, '6 distinct results');
    await sleep(1_500); // a would-be double run lands within a lease or two

    const per = runsPerStep(await runs());
    expect([...per.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6].map((s) => `r1:${s}`));
    expect([...per.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
  }, 120_000);

  it('(b) 300 steps across 2 workers × 8 slots: no duplicates, both fill all 8 slots', async () => {
    const { db, engine, results } = await setup();
    for (let seq = 1; seq <= 300; seq += 1) await engine.dispatch(task(seq, { ms: 80 }));
    const worker = { concurrency: 8, leaseMs: 5_000, pollIntervalMs: 20 };
    await Promise.all([
      spawnReady({ role: 'worker', instanceId: 'A', ...worker }),
      spawnReady({ role: 'worker', instanceId: 'B', ...worker }),
    ]);

    await until(() => distinctResults(results) === 300, 40_000, '300 distinct results');
    await sleep(300);

    const rows = await runs();
    const per = runsPerStep(rows);
    expect(per.size).toBe(300);
    expect([...per.values()].every((n) => n === 1)).toBe(true);
    expect(results).toHaveLength(300);
    for (const instance of ['A', 'B']) {
      const peak = Math.max(...rows.filter((r) => r.instance === instance).map((r) => r.in_flight));
      expect(peak, `peak in-flight on ${instance}`).toBe(8);
    }
    expect(await db.connection().from(TRANSPORT_TABLES.tasks).select('*')).toEqual([]);
  }, 180_000);

  it('(e) claims by priority, highest first, then oldest first', async () => {
    const { engine, results } = await setup();
    const priorities = [undefined, 5, -2, 5, 10, 0];
    for (const [i, p] of priorities.entries()) {
      await engine.dispatch(task(i + 1, {}, p));
      await sleep(5); // distinct created_at, so "oldest" is well defined
    }
    await spawnReady({ role: 'worker', instanceId: 'A', concurrency: 1 });
    await until(() => results.length === 6, 15_000, '6 results');
    // 10, then the two 5s oldest first, then the absent (= 0) before the explicit 0, then -2.
    expect((await runs()).map((r) => r.step_id)).toEqual([5, 2, 4, 1, 6, 3].map((s) => `r1:${s}`));
  }, 90_000);
});

import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunDispatch } from '../../../src/interfaces.js';
import { DbTransport } from '../../../src/transports/db.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { dbBackends } from '../../support/backends.js';

const runs = (n: number, reason: RunDispatch['reason'] = 'wake'): RunDispatch[] =>
  Array.from({ length: n }, (_, i) => ({ runId: `r-${i}`, reason }));

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A handler that records how many calls overlap. */
function overlapping(delayMs = 30) {
  const state = { active: 0, peak: 0, done: 0 };
  const handler = async (): Promise<void> => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    await new Promise((r) => setTimeout(r, delayMs));
    state.active -= 1;
    state.done += 1;
  };
  return { state, handler };
}

describe('QueueTransport run queue', () => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
  });
  const make = (adapter: MockAdapter) => {
    const t = new QueueTransport({ adapter: () => adapter, prefix: 'app', pollIntervalMs: 5 });
    transports.push(t);
    return t;
  };

  it('enqueues runs on <prefix>:runs with pushManyOn, 500 jobs per call', async () => {
    const adapter = new MockAdapter();
    await make(adapter).dispatchRuns(runs(1_200, 'start'));
    expect(adapter.pushManyCalls).toEqual([
      { queue: 'app:runs', count: 500 },
      { queue: 'app:runs', count: 500 },
      { queue: 'app:runs', count: 200 },
    ]);
    expect(await adapter.sizeOf('app:runs')).toBe(1_200);
  });

  it('runs at most `concurrency` handlers at once, and stops taking jobs on stop', async () => {
    const adapter = new MockAdapter();
    const transport = make(adapter);
    const { state, handler } = overlapping();
    const stop = transport.onRun(handler, { concurrency: 3 });
    await transport.dispatchRuns(runs(12));
    await until(() => state.done === 12);
    expect(state.peak).toBe(3);
    await stop();
    await transport.dispatchRuns(runs(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(state.done).toBe(12);
    expect(await adapter.sizeOf('app:runs')).toBe(2);
  });

  it('parks the run consumer while consumers are deferred', async () => {
    const adapter = new MockAdapter();
    const transport = make(adapter);
    transport.deferConsumers();
    const { state, handler } = overlapping(1);
    transport.onRun(handler, { concurrency: 2 });
    await transport.dispatchRuns(runs(2));
    await new Promise((r) => setTimeout(r, 80));
    expect(state.done).toBe(0);
    transport.startConsumers();
    await until(() => state.done === 2);
  });
});

describe.each(dbBackends({ mysql: true }))('DbTransport run queue on $name', ({ makeMemoryDb }) => {
  let db: Database | undefined;
  const transports: DbTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    await db?.manager.closeAll();
    db = undefined;
  });
  const make = async () => {
    db ??= await makeMemoryDb();
    const t = new DbTransport({ db, pollIntervalMs: 5 });
    transports.push(t);
    return t;
  };

  it('writes one `run` row per run, over several inserts', async () => {
    const transport = await make();
    await transport.dispatchRuns(runs(450, 'start'));
    const rows = (await (db as Database)
      .from(TRANSPORT_TABLES.messages)
      .where('kind', 'run')
      .count('* as n')) as Array<{ n: number | string }>;
    expect(Number(rows[0]?.n)).toBe(450);
  });

  it('runs at most `concurrency` handlers at once, and stops taking rows on stop', async () => {
    const transport = await make();
    const { state, handler } = overlapping();
    const stop = transport.onRun(handler, { concurrency: 3 });
    await transport.dispatchRuns(runs(12));
    await until(() => state.done === 12);
    expect(state.peak).toBe(3);
    await stop();
    await transport.dispatchRuns(runs(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(state.done).toBe(12);
  });

  it('two consumers never take the same row', async () => {
    const a = await make();
    const b = await make();
    const seen: string[] = [];
    const take = async (run: RunDispatch) => {
      seen.push(run.runId);
      await new Promise((r) => setTimeout(r, 5));
    };
    a.onRun(take, { concurrency: 4 });
    b.onRun(take, { concurrency: 4 });
    await a.dispatchRuns(runs(60));
    await until(() => seen.length >= 60);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });
});

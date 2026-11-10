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
    const stop = transport.onDispatchedRun(handler, { concurrency: 3 });
    await transport.dispatchRuns(runs(12));
    await until(() => state.done === 12);
    expect(state.peak).toBe(3);
    await stop();
    await transport.dispatchRuns(runs(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(state.done).toBe(12);
    expect(await adapter.sizeOf('app:runs')).toBe(2);
  });

  it('takes the more urgent run first, from its namespace queue', async () => {
    const adapter = new MockAdapter();
    const transport = make(adapter);
    await transport.dispatchRuns(
      [{ runId: 'low', priority: -3 }, { runId: 'normal' }, { runId: 'high', priority: 3 }],
      { namespace: 'blue' },
    );
    expect(await adapter.sizeOf('app-blue:runs')).toBe(3);
    const seen: string[] = [];
    transport.onDispatchedRun(async (run) => void seen.push(run.runId), {
      concurrency: 1,
      namespace: 'blue',
    });
    await until(() => seen.length === 3);
    expect(seen).toEqual(['high', 'normal', 'low']);
  });

  it('parks the run consumer while consumers are deferred', async () => {
    const adapter = new MockAdapter();
    const transport = make(adapter);
    transport.deferConsumers();
    const { state, handler } = overlapping(1);
    transport.onDispatchedRun(handler, { concurrency: 2 });
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

  /** The `run` rows nobody holds a claim on. */
  const unclaimedRuns = async (): Promise<number> => {
    const rows = (await (db as Database)
      .from(TRANSPORT_TABLES.messages)
      .where('kind', 'run')
      .whereNull('claimed_by')
      .count('* as n')) as Array<{ n: number | string }>;
    return Number(rows[0]?.n);
  };

  /** Watch `state` for `ms`: the handler count must not move (nothing is taken after stop). */
  const staysStill = async (state: { done: number; active: number }, ms: number) => {
    const done = state.done;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      expect(state.active).toBe(0);
      expect(state.done).toBe(done);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('runs at most `concurrency` handlers at once, and stops taking rows on stop', async () => {
    const transport = await make();
    const { state, handler } = overlapping();
    const stop = transport.onDispatchedRun(handler, { concurrency: 3 });
    await transport.dispatchRuns(runs(12));
    await until(() => state.done === 12);
    expect(state.peak).toBeGreaterThanOrEqual(1);
    expect(state.peak).toBeLessThanOrEqual(3);
    await stop();
    await transport.dispatchRuns(runs(2));
    await staysStill(state, 300);
    expect(await unclaimedRuns()).toBe(2);
  });

  it('a poll in flight when stop() is called takes nothing after stop() resolves', async () => {
    const live = await makeMemoryDb();
    // Park the next read of the messages table until released: a poll that started before stop()
    // and reads the table after the rows below were written.
    let armed = false;
    let parked = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = live.connection.bind(live);
    (live as { connection: typeof live.connection }).connection = ((name?: string) => {
      const client = connection(name);
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== 'knexQuery') return Reflect.get(target, prop, receiver);
          return () => gated(target.knexQuery());
        },
      });
    }) as typeof live.connection;
    const gated = (builder: ReturnType<ReturnType<Database['connection']>['knexQuery']>) => {
      const proxy: unknown = new Proxy(builder, {
        get(target, prop) {
          if (prop === 'then') {
            const sql = target.toSQL().sql;
            const isMessageRead =
              armed && sql.startsWith('select') && sql.includes(TRANSPORT_TABLES.messages);
            if (!isMessageRead) return target.then.bind(target);
            parked += 1;
            return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
              gate.then(() => target.then(ok, ko));
          }
          const value = Reflect.get(target, prop);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const out = value.apply(target, args);
            return out === target ? proxy : out;
          };
        },
      });
      return proxy as typeof builder;
    };
    const transport = new DbTransport({ db: live, pollIntervalMs: 5 });
    try {
      const { state, handler } = overlapping(5);
      const stop = transport.onDispatchedRun(handler, { concurrency: 3 });
      await transport.dispatchRuns(runs(3));
      await until(() => state.done === 3);
      armed = true;
      await until(() => parked > 0);
      armed = false;
      let stopped = false;
      const stopping = stop().then(() => {
        stopped = true;
      });
      await transport.dispatchRuns(runs(2));
      release();
      await stopping;
      expect(stopped).toBe(true);
      await staysStill(state, 300);
      expect(state.done).toBe(3);
      const rows = (await live
        .from(TRANSPORT_TABLES.messages)
        .where('kind', 'run')
        .whereNull('claimed_by')
        .count('* as n')) as Array<{ n: number | string }>;
      expect(Number(rows[0]?.n)).toBe(2);
    } finally {
      release();
      await transport.close();
      await live.manager.closeAll();
    }
  });

  it("claims only its namespace's rows", async () => {
    const transport = await make();
    const seen: Record<string, string[]> = { blue: [], green: [] };
    for (const ns of ['blue', 'green'] as const) {
      transport.onDispatchedRun(async (run) => void seen[ns]?.push(run.runId), {
        concurrency: 2,
        namespace: ns,
      });
    }
    await transport.dispatchRuns([{ runId: 'b1' }], { namespace: 'blue' });
    await transport.dispatchRuns([{ runId: 'g1' }, { runId: 'g2' }], { namespace: 'green' });
    await until(() => (seen.blue?.length ?? 0) + (seen.green?.length ?? 0) === 3);
    expect(seen.blue).toEqual(['b1']);
    expect(seen.green?.sort()).toEqual(['g1', 'g2']);
  });

  it('two consumers never take the same row', async () => {
    const a = await make();
    const b = await make();
    const seen: string[] = [];
    const take = async (run: RunDispatch) => {
      seen.push(run.runId);
      await new Promise((r) => setTimeout(r, 5));
    };
    a.onDispatchedRun(take, { concurrency: 4 });
    b.onDispatchedRun(take, { concurrency: 4 });
    await a.dispatchRuns(runs(60));
    await until(() => seen.length >= 60);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });
});

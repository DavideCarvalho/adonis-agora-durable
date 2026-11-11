import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import type { Transport } from '../../../src/interfaces.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { DbTransport } from '../../../src/transports/db.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import { dbBackends } from '../../support/backends.js';

/**
 * A namespaced engine stamps its runs with its namespace and dispatches their steps to
 * `<name>@<namespace>`. With no `partition` on its transport it must also SERVE those tokens, or its
 * own steps wait forever. Two engines on one backend, the default pool and `bulas`, each run their
 * own workflow's dispatched step.
 */

async function settle(store: InMemoryStateStore, runId: string, budgetMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const run = await store.getRun(runId);
    if (run && !['pending', 'running', 'suspended'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not settle`);
}

type Closable = Transport & {
  close(): Promise<void>;
  handle(name: string, fn: (input: unknown) => Promise<unknown>): void;
};

async function twoPools(transport: (namespace?: string) => Closable) {
  const store = new InMemoryStateStore();
  const engines: Array<{ engine: WorkflowEngine; transport: Closable }> = [];
  for (const namespace of [undefined, 'bulas']) {
    const t = transport(namespace);
    const engine = new WorkflowEngine({
      store,
      transport: t,
      ...(namespace ? { namespace } : {}),
    });
    t.handle('math.double', async (input) => ({ result: (input as { n: number }).n * 2 }));
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.step<{ result: number }>('math.double', { n: 21 });
      return a.result;
    });
    engines.push({ engine, transport: t });
  }
  return { store, engines };
}

async function bothRunTheirSteps(
  store: InMemoryStateStore,
  engines: Array<{ engine: WorkflowEngine }>,
) {
  const [plain, bulas] = engines;
  await plain?.engine.start('wf', {}, 'default-run');
  await bulas?.engine.start('wf', {}, 'bulas-run');
  const a = await settle(store, 'default-run');
  const b = await settle(store, 'bulas-run');
  expect(b.namespace).toBe('bulas');
  expect([a.status, a.output]).toEqual(['completed', 42]);
  expect([b.status, b.output]).toEqual(['completed', 42]);
}

describe.each(dbBackends({ mysql: true }))(
  'a namespaced engine serves its own partition (db on $name)',
  ({ makeTransportDb }) => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    it('runs the steps of both the default and the `bulas` engine', async () => {
      const db = await makeTransportDb();
      const { store, engines } = await twoPools(() => new DbTransport({ db, pollIntervalMs: 5 }));
      cleanups.push(async () => {
        for (const { transport } of engines) await transport.close();
        await db.manager.closeAll();
      });
      await bothRunTheirSteps(store, engines);
    });
  },
);

describe('a namespaced engine serves its own partition (queue)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('runs the steps of both the default and the `bulas` engine', async () => {
    const adapter = new MockAdapter();
    const { store, engines } = await twoPools(
      () => new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }),
    );
    cleanups.push(async () => {
      for (const { transport } of engines) await transport.close();
    });
    await bothRunTheirSteps(store, engines);
  });

  it('an explicit partition still wins', async () => {
    const adapter = new MockAdapter();
    const { store, engines } = await twoPools(
      (namespace) =>
        new QueueTransport({
          adapter: () => adapter,
          pollIntervalMs: 5,
          ...(namespace ? { partition: 'elsewhere' } : {}),
        }),
    );
    cleanups.push(async () => {
      for (const { transport } of engines) await transport.close();
    });
    const bulas = engines[1]?.engine as WorkflowEngine;
    await bulas.start('wf', {}, 'pinned-run');
    await new Promise((r) => setTimeout(r, 200));
    // Dispatched to `math.double@bulas`, served on `@elsewhere`: still waiting, as configured.
    expect((await store.getRun('pinned-run'))?.status).toBe('suspended');
  });
});

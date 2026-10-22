import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { DURABLE_TABLES } from '../../src/stores/lucid-schema.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * `''` is the bare/default pool everywhere else (transports treat it as no namespace), so the stores
 * must too: a run stamped `''` — by an engine configured with `namespace: ''`, or a legacy row — is a
 * default-pool run, written as `'default'` and matched by every `'default'` filter.
 */
const at = new Date('2026-06-11T00:00:00.000Z');
const run = (id: string, namespace: string | undefined): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  ...(namespace !== undefined ? { namespace } : {}),
  createdAt: at,
  updatedAt: at,
});

type Backend = {
  name: string;
  make: () => Promise<{
    store: StateStore & { withScope(s: { namespace?: string }): StateStore };
    legacy: (id: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

const backends: Backend[] = [
  {
    name: 'in-memory',
    make: async () => {
      const store = new InMemoryStateStore();
      return {
        store,
        // A row written before the normalization: stored verbatim with namespace ''.
        legacy: async (id) => {
          (store as unknown as { runs: Map<string, WorkflowRun> }).runs.set(id, run(id, ''));
        },
        close: async () => {},
      };
    },
  },
  ...dbBackends().map(({ name, makeStoreDb }) => ({
    name: `lucid ${name}`,
    make: async () => {
      const db: Database = await makeStoreDb();
      const store = new LucidStateStore(db);
      await store.createRun(run('seed', 'default'));
      return {
        store,
        legacy: async (id: string) => {
          // Copy the seed row's shape, with a raw '' namespace (what an older build wrote).
          const seed = await db.connection().from(DURABLE_TABLES.runs).where('id', 'seed').first();
          await db
            .connection()
            .table(DURABLE_TABLES.runs)
            .insert({ ...seed, id, namespace: '' });
        },
        close: async () => {
          await db.connection().from(DURABLE_TABLES.runs).where('id', 'seed').delete();
          await db.manager.closeAll();
        },
      };
    },
  })),
];

describe.each(backends)('empty-string namespace is the default pool — $name', ({ make }) => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("a run written with namespace '' is stored and read back as 'default'", async () => {
    const b = await make();
    close = b.close;
    await b.store.createRun(run('r1', ''));
    expect((await b.store.getRun('r1'))?.namespace).toBe('default');
    await b.store.updateRun('r1', { namespace: '' });
    expect((await b.store.getRun('r1'))?.namespace).toBe('default');
    expect((await b.store.listPendingRuns(10, 'default')).map((r) => r.id)).toContain('r1');
  });

  it("a legacy '' row is read as 'default' and matched by every 'default' filter", async () => {
    const b = await make();
    close = b.close;
    await b.legacy('old');
    expect((await b.store.getRun('old'))?.namespace).toBe('default');
    expect((await b.store.listPendingRuns(10, 'default')).map((r) => r.id)).toContain('old');
    expect((await b.store.listPendingRuns(10, '')).map((r) => r.id)).toContain('old');
    expect((await b.store.listRuns({ namespace: 'default' })).map((r) => r.id)).toContain('old');
    expect((await b.store.listRuns({ namespaces: ['default'] })).map((r) => r.id)).toContain('old');
    expect(
      await b.store.getRun.call(b.store.withScope({ namespace: 'default' }), 'old'),
    ).not.toBeNull();
    // And not matched by another pool.
    expect((await b.store.listPendingRuns(10, 'blue')).map((r) => r.id)).not.toContain('old');
  });
});

describe("an engine configured with namespace ''", () => {
  it("stamps 'default', so the run belongs to the default pool", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, namespace: '' });
    engine.register('wf', '1', async (ctx) => {
      await ctx.sleep('1h');
      return 'done';
    });
    await engine.start('wf', {}, 'e1');
    expect((await store.getRun('e1'))?.namespace).toBe('default');
    expect((await store.listRuns({ namespace: 'default' })).map((r) => r.id)).toContain('e1');
  });
});

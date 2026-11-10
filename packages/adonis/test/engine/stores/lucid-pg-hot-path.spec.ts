import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { LucidPgHotPath } from '../../../src/stores/lucid-pg-hot-path.js';
import { dbBackends } from '../../support/backends.js';

/**
 * The Lucid store's Postgres hot path (`lucid-pg-hot-path.ts`): the per-step statements go to the pg
 * connection as constant SQL. What it must keep from the builder path: a listener on the Knex client
 * still sees every statement, a global transaction still holds them, a debugged connection keeps the
 * builder, and named prepared statements work when asked for. The behaviour itself is pinned by the
 * state-store contract, which runs on Postgres through this path.
 */

/** The `pg` driver Knex uses (untyped here): its Client's `query`, to see what is sent. */
const pg = createRequire(import.meta.url)('pg') as {
  Client: { prototype: { query: (...args: unknown[]) => unknown } };
};

const at = new Date('2026-06-11T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'suspended',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

const postgres = dbBackends().filter((b) => b.name === 'postgres');

describe.skipIf(postgres.length === 0).each(postgres)('the Lucid store hot path on $name', (b) => {
  it('announces each statement on the Knex client, as the builder does', async () => {
    const db = await b.makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      await store.ensureSchema();
      const seen: string[] = [];
      const knex = db.connection().getWriteClient();
      const listen = (q: { sql: string }) => seen.push(q.sql);
      knex.on('query', listen);
      await store.createRun(run());
      expect(await store.tryLockRunAndGet('r1', 'a', 2_000, 1_000)).toMatchObject({
        id: 'r1',
        lockedBy: 'a',
      });
      knex.off('query', listen);
      expect(seen.some((sql) => sql.includes('returning "id", "workflow"'))).toBe(true);
      // The hot statements name their columns: a prepared `*` breaks when a column is added.
      expect(seen.some((sql) => /select \*|returning \*/.test(sql))).toBe(false);
      expect(seen.some((sql) => sql.startsWith('insert into "durable_workflow_runs"'))).toBe(true);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('runs inside a global transaction, which rolls its writes back', async () => {
    const db = await b.makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      await store.ensureSchema();
      await db.beginGlobalTransaction();
      await store.createRun(run());
      expect((await store.getRun('r1'))?.status).toBe('suspended');
      await store.updateRunIf('r1', ['suspended'], { status: 'running', updatedAt: new Date() });
      expect((await store.getRun('r1'))?.status).toBe('running');
      await db.rollbackGlobalTransaction();
      expect(await store.getRun('r1')).toBeNull();
    } finally {
      await db.manager.closeAll();
    }
  });

  it('sends named prepared statements when asked to', async () => {
    const db = await b.makeStoreDb();
    try {
      const store = new LucidStateStore(db, { preparedStatements: true });
      await store.ensureSchema();
      await store.createRun(run());
      await store.getRun('r1'); // the one-off column probe, before counting
      const names: Array<string | undefined> = [];
      const query = pg.Client.prototype.query;
      pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
        const config = args[0] as { name?: string } | string;
        if (typeof config === 'object') names.push(config.name);
        return query.apply(this, args);
      };
      try {
        // The same statement twice: one name, so each connection parses it once.
        for (let i = 0; i < 2; i += 1) expect((await store.getRun('r1'))?.id).toBe('r1');
        expect(await store.getRun('missing')).toBeNull();
      } finally {
        pg.Client.prototype.query = query;
      }
      expect(names).toHaveLength(3);
      expect(names[0]).toMatch(/^durable_/);
      expect(new Set(names).size).toBe(1);
    } finally {
      await db.manager.closeAll();
    }
  });
});

describe('the Lucid store hot path', () => {
  it('is taken only by a Postgres connection that is not being debugged or a transaction', () => {
    const knex = {
      client: { acquireConnection: async () => ({}), releaseConnection: async () => {} },
    };
    const client = (name: string, debug: boolean, isTransaction = false) =>
      ({ dialect: { name }, debug, isTransaction, getWriteClient: () => knex }) as never;
    expect(LucidPgHotPath.for(client('postgres', false))).toBeInstanceOf(LucidPgHotPath);
    expect(LucidPgHotPath.for(client('postgres', false, true))).toBeUndefined();
    expect(LucidPgHotPath.for(client('postgres', true))).toBeUndefined();
    expect(LucidPgHotPath.for(client('mysql', false))).toBeUndefined();
    expect(LucidPgHotPath.for(client('better-sqlite3', false))).toBeUndefined();
  });
});

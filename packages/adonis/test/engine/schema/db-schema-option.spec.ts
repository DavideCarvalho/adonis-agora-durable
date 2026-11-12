import { afterEach, describe, expect, it } from 'vitest';
import { checkSchema } from '../../../src/doctor/checks.js';
import { WorkflowEngine } from '../../../src/engine.js';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { mysqlLockName, schemaLockKey, validateSchemaName } from '../../../src/sql-schema.js';
import { stores } from '../../../src/stores/factory.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import {
  createDurableTables,
  DURABLE_SCHEMA_META_TABLE,
  DURABLE_TABLES,
  dropDurableTables,
} from '../../../src/stores/lucid-schema.js';
import {
  runRunDispatchContract,
  runStateStoreContract,
} from '../../../src/testing-kit/conformance.js';
import { assertTransportConformance } from '../../../src/testing-kit/index.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeMemoryDb } from '../../../src/transports/db-helpers.js';
import {
  createDurableTransportTables,
  createWorkerKeysTable,
  dropDurableTransportTables,
  TRANSPORT_TABLES,
  WORKER_KEYS_TABLE,
} from '../../../src/transports/db-schema.js';
import { transports } from '../../../src/transports/factory.js';
import { lucidWorkerKeys } from '../../../src/transports/worker-keys-db.js';
import {
  ALL_DURABLE_TABLES,
  type SchemaDb,
  schemaBackends,
  unqualifiedStatements,
} from '../../support/schema-db.js';

/**
 * The `schema` option: the durable tables (store, db transport, worker keys) live in a schema of
 * their own (a database on MySQL) while the connection's default stays the app's. Nothing is done
 * through the connection's `search_path`; every statement names the schema, which these suites
 * check two ways: the tables never appear in the default schema (an unqualified statement would fail
 * there), and no statement sent names a durable table without the schema in front.
 */

const at = new Date('2026-11-12T00:00:00.000Z');
const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'w',
  workflowVersion: '1',
  status: 'pending',
  input: { id },
  createdAt: at,
  updatedAt: at,
  ...over,
});

/** Fail with the offending statements when one names a durable table without the schema. */
function expectAllQualified(h: SchemaDb): void {
  expect(unqualifiedStatements(h.statements, h.schema)).toEqual([]);
}

async function expectNoTablesInDefault(h: SchemaDb): Promise<void> {
  const present: string[] = [];
  for (const table of ALL_DURABLE_TABLES) if (await h.defaultHasTable(table)) present.push(table);
  expect(present).toEqual([]);
}

async function tablesIn(h: SchemaDb, tables: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const table of tables) {
    if (await h.db.connection().schema.withSchema(h.schema).hasTable(table)) present.push(table);
  }
  return present;
}

describe.each(schemaBackends())('schema option on $name', (backend) => {
  const open: SchemaDb[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const h of open.splice(0)) await h.close();
  });
  const make = async (): Promise<SchemaDb> => {
    const h = await backend.make();
    open.push(h);
    return h;
  };

  // ── the store ──────────────────────────────────────────────────────────────

  runStateStoreContract(`LucidStateStore with schema (${backend.name})`, async () => {
    const h = await backend.make();
    const store = new LucidStateStore(h.db, { schema: h.schema });
    await store.ensureSchema();
    return {
      store,
      statements: () => h.statements.length,
      cleanup: async () => {
        try {
          expectAllQualified(h);
          await expectNoTablesInDefault(h);
        } finally {
          await h.close();
        }
      },
    };
  });

  it('ensureSchema creates the schema and every table in it, nothing in the default', async () => {
    const h = await make();
    const store = new LucidStateStore(h.db, { schema: h.schema });
    await store.ensureSchema();
    // Again: the fingerprint fast path reads the marker in the schema.
    await store.ensureSchema();
    expect(
      await tablesIn(h, [...Object.values(DURABLE_TABLES), DURABLE_SCHEMA_META_TABLE]),
    ).toEqual([...Object.values(DURABLE_TABLES), DURABLE_SCHEMA_META_TABLE]);
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });

  it('self-repair works inside the schema: a dropped column and index come back', async () => {
    const h = await make();
    await createDurableTables(h.db, undefined, { schema: h.schema });
    const runs = `${h.schema}.${DURABLE_TABLES.runs}`;
    // Knex's dropIndex does not qualify the index name, so this one is spelled out.
    await h.db.rawQuery(
      backend.name === 'mysql' ? 'alter table ?? drop index ??' : 'drop index ??',
      backend.name === 'mysql'
        ? [runs, 'durable_runs_created_idx']
        : [`${h.schema}.durable_runs_created_idx`],
    );
    await h.db.connection().schema.alterTable(runs, (t) => {
      t.dropColumn('origin');
    });
    const warnings: string[] = [];
    await createDurableTables(h.db, undefined, {
      schema: h.schema,
      force: true,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(warnings.join('\n')).toContain(`${DURABLE_TABLES.runs}.origin`);
    expect(warnings.join('\n')).toContain('durable_runs_created_idx');
    const store = new LucidStateStore(h.db, { schema: h.schema });
    await store.createRun(run('r1', { origin: 'app' } as Partial<WorkflowRun>));
    expect((await store.getRun('r1'))?.id).toBe('r1');
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });

  it('runs on the app transaction (the store bound to a global transaction)', async () => {
    const h = await make();
    const store = new LucidStateStore(h.db, { schema: h.schema });
    await store.ensureSchema();
    await h.db.beginGlobalTransaction();
    try {
      const engine = new WorkflowEngine({ store });
      engine.register('parked', '1', async (ctx) => ctx.waitForSignal('never'));
      const { runId } = await engine.start('parked', {}, 'tx-1');
      expect((await store.getRun(runId))?.id).toBe('tx-1');
      await store.createRun(run('tx-2'));
      expect((await store.getRuns(['tx-1', 'tx-2'])).map((r) => r.id).sort()).toEqual([
        'tx-1',
        'tx-2',
      ]);
    } finally {
      await h.db.rollbackGlobalTransaction();
    }
    // Rolled back with the app's transaction: the writes were on it.
    expect(await store.getRun('tx-1')).toBeNull();
    expect(await store.getRun('tx-2')).toBeNull();
    expectAllQualified(h);
  });

  it('two installs in two schemas of one database stay apart (and boot together)', async () => {
    const a = await make();
    const other = `${a.schema}b`;
    closers.push(async () => {
      await a.db
        .rawQuery(
          backend.name === 'mysql'
            ? 'drop database if exists ??'
            : 'drop schema if exists ?? cascade',
          [other],
        )
        .catch(() => {});
    });
    const storeA = new LucidStateStore(a.db, { schema: a.schema });
    const storeB = new LucidStateStore(a.db, { schema: other });
    await Promise.all([storeA.ensureSchema(), storeB.ensureSchema()]);
    await storeA.createRun(run('only-a'));
    expect((await storeA.getRun('only-a'))?.id).toBe('only-a');
    expect(await storeB.getRun('only-a')).toBeNull();
    await expectNoTablesInDefault(a);
  });

  it('dropDurableTables drops the tables in the schema only', async () => {
    const h = await make();
    await createDurableTables(h.db, undefined, { schema: h.schema });
    await dropDurableTables(h.db, undefined, { schema: h.schema });
    expect(await tablesIn(h, ALL_DURABLE_TABLES)).toEqual([]);
    expectAllQualified(h);
  });

  it('stores.lucid takes the top-level schema, and its own wins', async () => {
    const h = await make();
    const ctx = { app: { container: { make: async () => h.db } }, schema: h.schema } as never;
    const inherited = (await stores.lucid()(ctx)) as LucidStateStore;
    expect(inherited.schemaName).toBe(h.schema);
    const own = (await stores.lucid({ schema: 'elsewhere' })(ctx)) as LucidStateStore;
    expect(own.schemaName).toBe('elsewhere');
  });

  it('agora:doctor durable.schema: error while the tables are missing, ok once created', async () => {
    const h = await make();
    const app = {
      config: {
        get: (key: string) =>
          key === 'durable'
            ? { schema: h.schema, store: 'lucid', stores: { lucid: stores.lucid() } }
            : undefined,
      },
      container: { make: async () => h.db },
    } as never;
    const missing = await checkSchema(app);
    expect(missing.status).toBe('error');
    expect(missing.message).toContain(h.schema);
    await createDurableTables(h.db, undefined, { schema: h.schema });
    const ok = await checkSchema(app);
    expect(ok).toMatchObject({ status: 'ok' });
    // No transport has run yet: reported, not an error.
    expect(ok.message).toContain('not created yet');

    // The queue transport's worker keys alone are a complete set.
    await createWorkerKeysTable(h.db, undefined, { schema: h.schema });
    expect(await checkSchema(app)).toMatchObject({ status: 'ok' });

    // The db transport's tables, all of them: checked and reported.
    await createDurableTransportTables(h.db, undefined, { schema: h.schema });
    const withTransport = await checkSchema(app);
    expect(withTransport.status).toBe('ok');
    expect(withTransport.message).toContain('db transport tables');

    // Some of them only: an error naming what is missing.
    await h.db.connection().schema.withSchema(h.schema).dropTable(TRANSPORT_TABLES.messages);
    const partial = await checkSchema(app);
    expect(partial.status).toBe('error');
    expect(partial.message).toContain(TRANSPORT_TABLES.messages);
    expectAllQualified(h);
  });

  // ── the db transport and the worker keys ──────────────────────────────────

  it('DbTransport satisfies the transport contract with its tables in the schema', async () => {
    const h = await make();
    const transport = new DbTransport({ db: h.db, schema: h.schema, pollIntervalMs: 5 });
    await assertTransportConformance(transport);
    expect(await tablesIn(h, [...Object.values(TRANSPORT_TABLES), WORKER_KEYS_TABLE])).toEqual([
      ...Object.values(TRANSPORT_TABLES),
      WORKER_KEYS_TABLE,
    ]);
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });

  it('an engine with store and db transport in the schema runs a remote step end to end', async () => {
    const h = await make();
    const store = new LucidStateStore(h.db, { schema: h.schema });
    await store.ensureSchema();
    const engineSide = new DbTransport({ db: h.db, schema: h.schema, pollIntervalMs: 5 });
    const workerSide = new DbTransport({ db: h.db, schema: h.schema, pollIntervalMs: 5 });
    closers.push(async () => {
      await engineSide.close();
      await workerSide.close();
    });
    workerSide.handle('ext.double', async (input) => (input as number) * 2);
    const engine = new WorkflowEngine({ store, transport: engineSide });
    engine.register('doubler', '1', async (ctx) => ctx.step('ext.double', 21));
    const { runId } = await engine.start('doubler', {}, 'schema-e2e');
    const deadline = Date.now() + 20_000;
    let finished = await store.getRun(runId);
    while (finished?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      finished = await store.getRun(runId);
    }
    expect(finished?.output).toBe(42);
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });

  it('createDurableTransportTables / drop honor the schema', async () => {
    const h = await make();
    await createDurableTransportTables(h.db, undefined, { schema: h.schema });
    const all = [...Object.values(TRANSPORT_TABLES), WORKER_KEYS_TABLE];
    expect(await tablesIn(h, all)).toEqual(all);
    // Idempotent, including the added-columns back-fill and (MySQL) the longtext check.
    await createDurableTransportTables(h.db, undefined, { schema: h.schema });
    await dropDurableTransportTables(h.db, undefined, { schema: h.schema });
    expect(await tablesIn(h, all)).toEqual([]);
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });

  it('transports.db takes the top-level schema; lucidWorkerKeys writes into its own', async () => {
    const h = await make();
    const ctx = { app: { container: { make: async () => h.db } }, schema: h.schema } as never;
    const transport = (await transports.db({ pollIntervalMs: 5 })(ctx)) as DbTransport;
    closers.push(() => transport.close());
    await transport.dispatch({
      stepId: 's1',
      runId: 'r1',
      seq: 0,
      name: 'ext.work',
      group: 'ext.work',
      input: null,
      attempt: 1,
    } as never);
    const rows = await h.db
      .connection()
      .from(`${h.schema}.${TRANSPORT_TABLES.tasks}`)
      .select('step_id');
    expect(rows.map((r) => r.step_id)).toEqual(['s1']);

    const keys = lucidWorkerKeys(h.db, { schema: h.schema });
    await keys.put('k', 'v', Date.now() + 60_000);
    expect(await keys.live(Date.now())).toEqual([{ key: 'k', value: 'v' }]);
    await expectNoTablesInDefault(h);
    expectAllQualified(h);
  });
});

/** The run queue (messages table) with the transport in a schema. */
describe.each(schemaBackends())('db transport run queue in a schema on $name', (backend) => {
  let h: SchemaDb | undefined;
  runRunDispatchContract('DbTransport (schema)', {
    setup: async () => {
      h = await backend.make();
    },
    make: () =>
      new DbTransport({
        db: (h as SchemaDb).db,
        schema: (h as SchemaDb).schema,
        pollIntervalMs: 5,
      }),
    teardown: async () => {
      const done = h;
      h = undefined;
      if (!done) return;
      try {
        expect(unqualifiedStatements(done.statements, done.schema)).toEqual([]);
      } finally {
        await done.close();
      }
    },
  });
});

describe('schema option: what it refuses', () => {
  it('SQLite has no schemas: every piece fails instead of ignoring it', async () => {
    const db = makeMemoryDb();
    try {
      const message = /has no schemas/;
      expect(() => new LucidStateStore(db, { schema: 'durable' })).toThrow(message);
      expect(() => new DbTransport({ db, schema: 'durable' })).toThrow(message);
      expect(() => lucidWorkerKeys(db, { schema: 'durable' })).toThrow(message);
      await expect(createDurableTables(db, undefined, { schema: 'durable' })).rejects.toThrow(
        message,
      );
      await expect(
        createDurableTransportTables(db, undefined, { schema: 'durable' }),
      ).rejects.toThrow(message);
      await expect(dropDurableTables(db, undefined, { schema: 'durable' })).rejects.toThrow(
        message,
      );
      await expect(
        dropDurableTransportTables(db, undefined, { schema: 'durable' }),
      ).rejects.toThrow(message);
      const ctx = { app: { container: { make: async () => db } }, schema: 'durable' } as never;
      await expect(stores.lucid()(ctx)).rejects.toThrow(message);
      await expect(transports.db()(ctx)).rejects.toThrow(message);
      // Without a schema SQLite works as before.
      expect(() => new LucidStateStore(db)).not.toThrow();
    } finally {
      await db.manager.closeAll();
    }
  });

  it('rejects a name that is not a plain identifier', () => {
    for (const bad of ['', '1abc', 'a.b', 'a"b', 'a-b', 'x'.repeat(64), 'a b']) {
      expect(() => validateSchemaName(bad, 'test')).toThrow(/not a valid schema name/);
    }
    for (const good of ['durable', '_d', 'Durable_1', 'a$b', 'x'.repeat(63)]) {
      expect(validateSchemaName(good, 'test')).toBe(good);
    }
    expect(validateSchemaName(undefined, 'test')).toBeUndefined();
  });

  it('the schema lock key is the old one without a schema, and per schema with one', () => {
    expect(schemaLockKey(42, undefined)).toBe(42);
    const a = schemaLockKey(42, 'a');
    const b = schemaLockKey(42, 'b');
    expect(a).not.toBe(b);
    expect(Number.isSafeInteger(a)).toBe(true);
  });

  it('a MySQL lock name stays within 64 characters', () => {
    expect(mysqlLockName('durable_schema:', 'durable')).toBe('durable_schema:durable');
    const long = mysqlLockName('durable_schema:', 'x'.repeat(63));
    expect(long).toHaveLength(64);
    expect(long).not.toBe(mysqlLockName('durable_schema:', `${'x'.repeat(62)}y`));
  });
});

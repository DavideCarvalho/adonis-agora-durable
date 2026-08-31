import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { stores } from '../../../src/stores/factory.js';
import type { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';

/**
 * The store factory thunk (`stores.lucid()`) and the Lucid store's connection handling — the two boot
 * bugs that only surface when `durable: true` runs through the app's real provider boot.
 *
 * The provider builds this thunk during its OWN `boot()` (resolving the `WorkflowEngine` singleton),
 * BEFORE `app.booted()` fires — so `@adonisjs/lucid/services/db`'s default export is still `undefined`
 * then. The thunk must resolve the `Database` from the container (`'lucid.db'`), which these tests
 * stand in for with a fake ctx. In a plain vitest process there is no booted lucid service at all, so
 * the pre-fix thunk (which read `services/db`.default) would build a store over `undefined` and throw
 * on first use — exactly the failure the provider path hit.
 */

/** A fake boot-time ctx whose container resolves `'lucid.db'` to the given Database. */
function ctxWithDb(db: Database) {
  return {
    app: {
      container: {
        make: async (service: unknown) => {
          if (service !== 'lucid.db')
            throw new Error(`unexpected container.make(${String(service)})`);
          return db;
        },
      },
    },
  } as never;
}

const at = new Date('2026-06-11T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('stores.lucid — boot-time db resolution + connection routing', () => {
  const open: Database[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.manager.closeAll();
  });

  it('resolves the Lucid Database from the container (not services/db) and round-trips a run', async () => {
    const db = await makeStoreDb();
    open.push(db);

    // Build the store the way the provider does at boot: call the thunk with a boot-time ctx.
    const store = (await stores.lucid()(ctxWithDb(db))) as LucidStateStore;

    // A createRun/getRun round-trip proves the store is wired to the real, container-resolved db —
    // and that createRun goes through the connection client (the second bug), not a bare `this.db`.
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.id).toBe('r1');
    expect(loaded?.workflow).toBe('checkout');
  });

  it('honors a named connection: schema + writes land where reads look, not on the default', async () => {
    // Two independent in-memory connections. The DEFAULT ('primary') never gets the durable tables;
    // only the named 'secondary' does. A store pinned to 'secondary' must create its schema and write
    // its runs there — the pre-fix createRun/ensureSchema used the DEFAULT connection, so this would
    // throw "no such table" on 'primary'.
    const logger = new Logger({ enabled: false });
    const emitter = new Emitter(undefined as never);
    const sqlite = () => ({
      client: 'better-sqlite3' as const,
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    const db = new Database(
      { connection: 'primary', connections: { primary: sqlite(), secondary: sqlite() } },
      logger,
      emitter,
    );
    open.push(db);

    const store = (await stores.lucid({ connection: 'secondary' })(
      ctxWithDb(db),
    )) as LucidStateStore;
    await store.ensureSchema();
    await store.createRun(run());

    // Read back through the store (also on 'secondary').
    expect((await store.getRun('r1'))?.id).toBe('r1');
    // The default connection must have NO durable tables — proving nothing leaked to it.
    expect(await db.connection('primary').schema.hasTable('durable_workflow_runs')).toBe(false);
    expect(await db.connection('secondary').schema.hasTable('durable_workflow_runs')).toBe(true);
  });
});

import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoryDb } from '../../../src/stores/lucid-helpers.js';
import { DURABLE_TABLES, createDurableTables } from '../../../src/stores/lucid-schema.js';

/**
 * `createDurableTables` self-heals: on an existing table missing a column a newer library writes, it
 * silently `ALTER`s the column in. That is load-bearing behaviour (apps in production depend on the
 * repair, and `autoSchema` calls it at every boot), so it stays — but it must not stay SILENT.
 *
 * It is why the stub's drift was undetectable. `recordStepHeartbeat`'s write is fire-and-forget in
 * the engine, so a missing `last_heartbeat_at` produced no error; the repair added the column at
 * every boot, so it produced no failure either. Two individually correct defensive behaviours
 * combined into an information vacuum: nothing anywhere could say that a migration-managed schema
 * was wrong.
 *
 * The discriminator is the whole point. A warning on every call would be filtered as boot noise and
 * would restore the vacuum, so the negative case below (a current schema logs NOTHING) is the test
 * that matters, and the one the mutation in this file's sibling commit message flips.
 */

/** Captures `warn` calls. Structurally a `DurableSchemaLogger`; also proves the sink is injectable. */
function recordingLogger() {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
}

/**
 * A `durable_step_checkpoints` table shaped like one an app generated BEFORE the heartbeat columns
 * existed — i.e. what every consumer that ran `node ace configure` against an older release has in
 * its database right now. Built by creating the current schema and dropping the two columns, so it
 * tracks the real table rather than a hand-written replica that could itself drift.
 */
async function withPreHeartbeatCheckpoints(db: Database): Promise<void> {
  await createDurableTables(db, undefined, { logger: { warn: () => {} } });
  await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (table) => {
    table.dropColumn('last_heartbeat_at');
  });
  await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (table) => {
    table.dropColumn('heartbeat_progress');
  });
}

describe('createDurableTables warns only when it actually repairs something', () => {
  const open: Database[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()?.manager.closeAll();
  });

  it('says nothing when it creates the tables from scratch', async () => {
    const db = makeMemoryDb();
    open.push(db);
    const logger = recordingLogger();

    await createDurableTables(db, undefined, { logger });

    // A fresh database is the overwhelmingly common case (a correctly migrated app, a test, a new
    // deploy). It reaches only the `createTable` branches, never a `hasColumn` one, so there is
    // nothing to report — and reporting anyway is what would make the signal worthless.
    expect(logger.warnings).toEqual([]);
  });

  it('says nothing on a second call over an already-current schema', async () => {
    const db = makeMemoryDb();
    open.push(db);
    const logger = recordingLogger();

    await createDurableTables(db, undefined, { logger });
    await createDurableTables(db, undefined, { logger });

    // This is the boot path: `autoSchema` calls `ensureSchema()` on EVERY boot of an app whose
    // migrations are current. Warning here would fire forever and get filtered.
    expect(logger.warnings).toEqual([]);
  });

  it('emits exactly one warning naming the table and both columns when it adds them', async () => {
    const db = makeMemoryDb();
    open.push(db);
    await withPreHeartbeatCheckpoints(db);
    const logger = recordingLogger();

    await createDurableTables(db, undefined, { logger });

    expect(logger.warnings).toHaveLength(1);
    const [warning] = logger.warnings;
    expect(warning).toContain(`${DURABLE_TABLES.checkpoints}.last_heartbeat_at`);
    expect(warning).toContain(`${DURABLE_TABLES.checkpoints}.heartbeat_progress`);
    // The operator's next action, not just the diagnosis: the schema belongs to the library, so the
    // fix is a migration that calls the library.
    expect(warning).toContain('createDurableTables(db, this.db.connectionName)');
    // It must not blame something the app can't see. Naming a column that was NOT added would send
    // an operator hunting a repair that never happened.
    expect(warning).not.toContain('parallel_group');
    expect(warning).not.toContain(`${DURABLE_TABLES.runs}.`);
  });

  it('repairs the columns for real, and goes quiet once it has', async () => {
    const db = makeMemoryDb();
    open.push(db);
    await withPreHeartbeatCheckpoints(db);
    const logger = recordingLogger();

    await createDurableTables(db, undefined, { logger });
    // Fresh schema builder per probe — knex's is stateful and replays accumulated statements.
    expect(
      await db.connection().schema.hasColumn(DURABLE_TABLES.checkpoints, 'last_heartbeat_at'),
    ).toBe(true);
    expect(
      await db.connection().schema.hasColumn(DURABLE_TABLES.checkpoints, 'heartbeat_progress'),
    ).toBe(true);

    await createDurableTables(db, undefined, { logger });
    // Still one: the second call found nothing to do. A repair is news once, not at every boot from
    // then on.
    expect(logger.warnings).toHaveLength(1);
  });

  it('reports several repairs in one warning, not one warning each', async () => {
    const db = makeMemoryDb();
    open.push(db);
    await withPreHeartbeatCheckpoints(db);
    await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (table) => {
      table.dropColumn('parallel_group');
    });
    await db.connection().schema.alterTable(DURABLE_TABLES.runs, (table) => {
      table.dropColumn('priority');
    });
    const logger = recordingLogger();

    await createDurableTables(db, undefined, { logger });

    expect(logger.warnings).toHaveLength(1);
    const [warning] = logger.warnings;
    expect(warning).toContain(`${DURABLE_TABLES.runs}.priority`);
    expect(warning).toContain(`${DURABLE_TABLES.checkpoints}.parallel_group`);
    expect(warning).toContain(`${DURABLE_TABLES.checkpoints}.last_heartbeat_at`);
  });

  it('defaults to console.warn so the boot path is audible without any plumbing', async () => {
    const db = makeMemoryDb();
    open.push(db);
    await withPreHeartbeatCheckpoints(db);

    // `LucidStateStore.ensureSchema()` — the boot path the provider calls when `autoSchema !== false`
    // — passes no logger, and the store has none to pass. If the default were a no-op, item B would
    // be audible only to callers who already knew to ask, which is nobody.
    const original = console.warn;
    const seen: unknown[] = [];
    console.warn = (...args: unknown[]) => seen.push(args[0]);
    try {
      await createDurableTables(db);
    } finally {
      console.warn = original;
    }

    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain(`${DURABLE_TABLES.checkpoints}.last_heartbeat_at`);
  });
});

/**
 * Runs the published migration stub the way a consumer app does, end to end, and asserts the
 * database it leaves behind.
 *
 * WHY A SEPARATE PROCESS. Two reasons, both load-bearing:
 *  1. `@adonisjs/lucid/services/db` — which the stub imports, and which is the whole reason the
 *     stub can call `createDurableTables` at all — resolves `container.make(Database)` against
 *     the app service at module-evaluation time. It only works inside a booted AdonisJS app, so
 *     this file boots one.
 *  2. The stub is resolved as a real dependency (`@adonis-agora/durable` through its `exports`
 *     map, i.e. the BUILT dist), from a scratch app directory with its own `node_modules`. Inside
 *     vitest the package would resolve to `src/`, which is not what ships.
 *
 * Exits 0 on success, non-zero with a message on failure. Driven by `migration-stub-runs.spec.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { Logger } from '@adonisjs/core/logger';
import { setApp } from '@adonisjs/core/services/app';
import { Database } from '@adonisjs/lucid/database';
import { MigrationRunner } from '@adonisjs/lucid/migration';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const stubPath = join(pkgRoot, 'stubs/database/migrations/create_durable_tables.stub');

/**
 * `pool.max = 1` on purpose. It is the tightest pool an app can configure (and what Adonis's own
 * SQLite guidance suggests), and it is the configuration that fails if the stub ever loses
 * `static disableTransactions = true`: the migrator's transaction would hold the only connection
 * while `createDurableTables` — which checks out its own — waited for one, and the migration would
 * die with "Timeout acquiring a connection". A larger pool would hide that regression.
 */
const POOL_MAX = 1;

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

// ── build a scratch consumer app ────────────────────────────────────────────────────────────
const appRoot = mkdtempSync(join(tmpdir(), 'durable-stub-migration-'));
try {
  mkdirSync(join(appRoot, 'database/migrations'), { recursive: true });
  mkdirSync(join(appRoot, 'node_modules/@adonis-agora'), { recursive: true });
  writeFileSync(
    join(appRoot, 'package.json'),
    '{ "name": "durable-stub-migration-app", "type": "module", "private": true }\n',
  );
  // Depend on the package by NAME, the way an app does — so `@adonis-agora/durable` resolves
  // through the `exports` map into `dist/`.
  symlinkSync(pkgRoot, join(appRoot, 'node_modules/@adonis-agora/durable'));
  for (const dep of ['@adonisjs', 'better-sqlite3']) {
    symlinkSync(join(pkgRoot, 'node_modules', dep), join(appRoot, 'node_modules', dep));
  }

  // Render the stub exactly as `node ace configure` does: strip the `{{{ exports() }}}` header,
  // keep every other byte. Written as `.js` because a scratch app has no TypeScript loader; the
  // stub's body carries no type syntax, so the executed statements are byte-identical.
  const stubSource = readFileSync(stubPath, 'utf8');
  const rendered = stubSource.replace(/^\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (rendered === stubSource) throw new Error('stub header not found — render assumption broken');
  const migrationName = '1785200000000_create_durable_tables';
  writeFileSync(join(appRoot, `database/migrations/${migrationName}.js`), rendered);

  // ── a real, booted AdonisJS app ───────────────────────────────────────────────────────────
  const dbFile = join(appRoot, 'app.sqlite');
  const db = new Database(
    {
      connection: 'primary',
      connections: {
        primary: {
          client: 'better-sqlite3',
          connection: { filename: dbFile },
          useNullAsDefault: true,
          pool: { min: 1, max: POOL_MAX, acquireTimeoutMillis: 5_000 },
          migrations: { naturalSort: true },
        },
      },
    },
    new Logger({ enabled: false }),
    new Emitter({ container: {} }),
  );

  const app = new AppFactory().create(pathToFileURL(`${appRoot}/`), () => {});
  await app.init();
  // What lucid's own database_provider registers: the Database singleton, aliased `lucid.db`.
  // `services/db` resolves `make(Database)`, so binding only the alias is not enough.
  app.container.singleton(Database, () => db);
  app.container.alias('lucid.db', Database);
  await app.boot();
  setApp(app);

  // A FRESH schema builder per probe: knex's builder is stateful, and reusing one instance replays
  // its accumulated statements and reports the first result (which reads as "the table is still
  // there" after a rollback that did drop it).
  const schema = () => db.connection('primary').schema;

  // ── migration:run ─────────────────────────────────────────────────────────────────────────
  const up = new MigrationRunner(db, app, { direction: 'up' });
  await up.run();
  if (up.error) throw up.error;
  check(up.status === 'completed', `migration:run status was "${up.status}", expected "completed"`);

  const tables = [
    'durable_workflow_runs',
    'durable_step_checkpoints',
    'durable_run_attributes',
    'durable_signal_waiters',
    'durable_buffered_signals',
    'durable_buffered_events',
  ];
  for (const table of tables) {
    check(await schema().hasTable(table), `table ${table} was not created`);
  }
  // The two columns the stub used to omit, and the reason this whole item exists.
  for (const column of ['last_heartbeat_at', 'heartbeat_progress']) {
    check(
      await schema().hasColumn('durable_step_checkpoints', column),
      `column durable_step_checkpoints.${column} was not created`,
    );
  }

  const recorded = await db.connection('primary').from('adonis_schema').select('name');
  check(
    recorded.length === 1 && recorded[0].name.endsWith(migrationName),
    `adonis_schema should hold exactly this migration, got ${JSON.stringify(recorded)}`,
  );

  // Present is not the same as usable: write a heartbeat through the real store.
  const { LucidStateStore } = await import('@adonis-agora/durable');
  const store = new LucidStateStore(db);
  const at = new Date('2026-07-29T12:00:00.000Z');
  await store.createRun({
    id: 'stub-run',
    workflow: 'stub',
    workflowVersion: '1',
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
  });
  await store.saveCheckpoint({
    runId: 'stub-run',
    seq: 0,
    name: 'beat',
    kind: 'remote',
    stepId: 's0',
    status: 'pending',
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
  });
  await store.recordStepHeartbeat('stub-run', 0, new Date(at.getTime() + 1_000), { pages: 3 });
  const [checkpoint] = await store.listCheckpoints('stub-run');
  check(
    checkpoint?.lastHeartbeatAt?.getTime() === at.getTime() + 1_000,
    `recordStepHeartbeat did not round-trip lastHeartbeatAt (got ${String(checkpoint?.lastHeartbeatAt)})`,
  );
  check(
    JSON.stringify(checkpoint?.heartbeatProgress) === JSON.stringify({ pages: 3 }),
    `recordStepHeartbeat did not round-trip heartbeatProgress (got ${JSON.stringify(checkpoint?.heartbeatProgress)})`,
  );

  // ── migration:rollback ────────────────────────────────────────────────────────────────────
  const down = new MigrationRunner(db, app, { direction: 'down' });
  await down.run();
  if (down.error) throw down.error;
  for (const table of tables) {
    check(!(await schema().hasTable(table)), `table ${table} survived the rollback`);
  }

  await db.manager.closeAll();
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`stub migration harness: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('stub migration harness: OK');

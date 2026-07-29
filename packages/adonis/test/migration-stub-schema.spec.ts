import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The migration stub used to reproduce `createDurableTables`'s DDL, and the copy drifted twice:
 * once on `parallel_group`, then on `last_heartbeat_at` / `heartbeat_progress` — columns
 * `LucidStateStore.recordStepHeartbeat` writes on every beat. A consumer audit showed why the
 * previous version of this spec (a column-list diff between the stub and `lucid-schema.ts`) was
 * not enough: fixing the GENERATOR does not fix what it already generated. Every app that ran
 * `node ace configure` before the fix still holds a frozen copy of the old DDL, working only
 * because the boot-time `ensureSchema()` silently `ALTER`s the missing columns in.
 *
 * So the stub no longer holds DDL at all: it calls `createDurableTables` /
 * `dropDurableTables`. Drift is then structurally impossible rather than diff-tested, and this
 * spec guards the property that MAKES it impossible — that the stub delegates and does not
 * re-inline. It is not the old test with new wording: the old one compared two column lists (and
 * only for `durable_step_checkpoints`, so a drift in `durable_workflow_runs` would have sailed
 * past it); this one asserts there is only one list.
 *
 * That the stub actually RUNS is a separate question, and a real one now that it depends on
 * library API rather than on inert DDL — see `migration-stub-runs.spec.ts`.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));

const stubPath = join(
  currentDir,
  '..',
  'stubs',
  'database',
  'migrations',
  'create_durable_tables.stub',
);
const indexPath = join(currentDir, '..', 'src', 'index.ts');

/** The stub's body, with the `{{{ exports() }}}` codemod header `configure` strips off. */
function renderStub(): string {
  const source = readFileSync(stubPath, 'utf8');
  const body = source.replace(/^\{\{\{[\s\S]*?\}\}\}\n/, '');
  expect(body, 'the stub must start with the {{{ exports() }}} header').not.toBe(source);
  return body;
}

describe('the durable migration stub delegates instead of copying the DDL', () => {
  const stub = renderStub();

  it('declares no tables and no columns of its own', () => {
    // `createTable` / `alterTable` / `table.string(...)` in here would mean a THIRD copy of the
    // schema is back (lucid-schema.ts, the stub, and every consumer's frozen migration file).
    expect(stub).not.toMatch(/\bcreateTable\(/);
    expect(stub).not.toMatch(/\balterTable\(/);
    expect(stub).not.toMatch(/\btable\.(string|integer|bigInteger|text|double|increments)\(/);
  });

  it('calls createDurableTables in up() and dropDurableTables in down()', () => {
    expect(stub).toMatch(
      /async up\(\)\s*\{\s*await createDurableTables\(db, this\.db\.connectionName\)/,
    );
    expect(stub).toMatch(
      /async down\(\)\s*\{\s*await dropDurableTables\(db, this\.db\.connectionName\)/,
    );
  });

  it('takes the Database manager from services/db, not the migration client', () => {
    // The whole reason the earlier attempt at this (plan 004) was abandoned: `createDurableTables`
    // needs `db.connection(name).schema`, and a migration's `this.db` is a QueryClientContract with
    // no `.connection()`. `@adonisjs/lucid/services/db` IS the Database manager; `this.db` is kept
    // only for the connection NAME, so `migration:run --connection=x` provisions x.
    expect(stub).toMatch(/^import db from '@adonisjs\/lucid\/services\/db'$/m);
    expect(stub).not.toMatch(/createDurableTables\(this\.db/);
  });

  it('opts out of the migrator transaction', () => {
    // Required, not stylistic: the DDL runs on a connection the Database manager checks out itself,
    // so on a `pool: { max: 1 }` connection the migrator transaction would hold the only connection
    // while `createDurableTables` waited for a free one. Verified by removing this line and watching
    // the migration die with "Timeout acquiring a connection".
    expect(stub).toMatch(/static disableTransactions = true/);
  });

  it('only calls functions the package actually exports', () => {
    // A stub can use nothing but public API, and a rename in `src/index.ts` would otherwise leave a
    // migration that throws at `migration:run` in a consumer app rather than failing here.
    const index = readFileSync(indexPath, 'utf8');
    for (const name of ['createDurableTables', 'dropDurableTables']) {
      expect(stub, `stub should import ${name}`).toContain(name);
      expect(index, `src/index.ts must export ${name}`).toMatch(
        new RegExp(`export \\{[^}]*\\b${name}\\b`, 's'),
      );
    }
  });
});

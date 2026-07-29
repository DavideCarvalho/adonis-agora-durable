import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards against the drift that shipped a migration stub whose
 * `durable_step_checkpoints` table was missing `last_heartbeat_at` and
 * `heartbeat_progress` — columns `LucidStateStore.recordStepHeartbeat` writes on
 * every step beat, but which the auto-schema path (`createDurableTables` in
 * `lucid-schema.ts`) and the published migration stub each declare
 * independently. The same drift happened once before with `parallel_group`.
 *
 * There is no shared source of truth for these two column lists today (see
 * plan 008's "What plan 004 got wrong" — `BaseSchema.db` inside a migration is
 * a `QueryClientContract` with no `.connection()`, so the migration cannot call
 * `createDurableTables` directly, and a shared-schema-builder refactor was
 * attempted and abandoned because `BaseSchema.schema`'s calls are tracked and
 * executed later, which breaks the `hasTable`/`hasColumn` branching the
 * auto-schema path relies on). So this spec compares the two column lists as
 * text, which is crude but directly encodes the invariant that keeps getting
 * violated.
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
const schemaPath = join(currentDir, '..', 'src', 'stores', 'lucid-schema.ts');

/**
 * Extracts the column names declared inside a `createTable('durable_step_checkpoints', ...)`
 * (or `createTable(DURABLE_TABLES.checkpoints, ...)`) call, and ONLY that call — not any
 * sibling `alterTable` auto-migration that follows it in an `else` branch. Boundaries are found
 * by bracket-depth matching from the `createTable(` token to its closing `)`, rather than by
 * scanning to the next `createTable(` call, so that a column present only in the auto-migrate
 * branch (and missing from the initial `createTable`) is NOT masked — that asymmetry is exactly
 * the shape of bug this spec exists to catch: a column absent from a fresh install's `createTable`
 * even though an existing-install `alterTable` path still mentions it.
 */
function extractCheckpointColumns(source: string): string[] {
  // The stub spells the table name as a literal (`createTable('durable_step_checkpoints'`);
  // `lucid-schema.ts` spells it as `createTable(DURABLE_TABLES.checkpoints`. Match either.
  const markers = [
    "createTable('durable_step_checkpoints'",
    'createTable(DURABLE_TABLES.checkpoints',
  ];
  const found = markers
    .map((marker) => ({ marker, index: source.indexOf(marker) }))
    .find(({ index }) => index !== -1);
  if (!found) {
    throw new Error('could not find a durable_step_checkpoints createTable block');
  }

  // Position right after the opening '(' of `createTable(`.
  const openParenIndex = source.indexOf('(', found.index + 'createTable'.length);
  let depth = 1;
  let cursor = openParenIndex + 1;
  while (depth > 0) {
    if (cursor >= source.length) {
      throw new Error('unbalanced brackets while scanning createTable(...) call');
    }
    const char = source[cursor];
    if (char === '(' || char === '{' || char === '[') depth++;
    else if (char === ')' || char === '}' || char === ']') depth--;
    cursor++;
  }
  const block = source.slice(openParenIndex + 1, cursor);

  const columnPattern = /table\.\w+\('([^']+)'/g;
  const columns: string[] = [];
  for (const match of block.matchAll(columnPattern)) {
    columns.push(match[1]);
  }
  return columns;
}

describe('migration stub vs. lucid-schema drift', () => {
  const stubSource = readFileSync(stubPath, 'utf8');
  const schemaSource = readFileSync(schemaPath, 'utf8');

  const stubColumns = extractCheckpointColumns(stubSource);
  const schemaColumns = extractCheckpointColumns(schemaSource);

  it('the stub declares last_heartbeat_at on durable_step_checkpoints', () => {
    expect(stubColumns).toContain('last_heartbeat_at');
  });

  it('the stub declares heartbeat_progress on durable_step_checkpoints', () => {
    expect(stubColumns).toContain('heartbeat_progress');
  });

  it('lucid-schema.ts declares last_heartbeat_at on durable_step_checkpoints', () => {
    expect(schemaColumns).toContain('last_heartbeat_at');
  });

  it('lucid-schema.ts declares heartbeat_progress on durable_step_checkpoints', () => {
    expect(schemaColumns).toContain('heartbeat_progress');
  });

  it("the stub's durable_step_checkpoints column set equals lucid-schema.ts's", () => {
    expect(new Set(stubColumns)).toEqual(new Set(schemaColumns));
  });
});

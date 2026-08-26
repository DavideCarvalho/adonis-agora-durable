# Plan 004: Stop the published migration stub from drifting off the real schema

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/stubs/database/migrations/ packages/adonis/src/stores/lucid-schema.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

There are two independent definitions of this package's database schema: the
programmatic one in `src/stores/lucid-schema.ts` (used by the `autoSchema: true`
default) and a hand-copied DDL in the published migration stub (used by
`node ace configure` + `migration:run`, which is also the only path when
`autoSchema: false`). They have already drifted.

The stub's `durable_step_checkpoints` table is missing `last_heartbeat_at` and
`heartbeat_progress`, two columns that `LucidStateStore.recordStepHeartbeat`
writes on every step beat. An app provisioned through the documented migration
path issues an UPDATE against columns that do not exist. The engine swallows the
failure, so step liveness silently never appears in the dashboard or in
`durable:runs --stale`, with no error anywhere.

This is the second instance of this drift (`parallel_group` was handled the same
way before). Fixing the columns alone would leave the underlying cause — two
sources of truth — intact, so this plan makes the stub delegate to the exported
schema functions instead.

## Current state

- The stub's checkpoints table —
  `packages/adonis/stubs/database/migrations/create_durable_tables.stub:37-57`.
  Note the absence of any heartbeat column:

  ```ts
  this.schema.createTable('durable_step_checkpoints', (table) => {
    table.string('run_id').notNullable()
    table.integer('seq').notNullable()
    table.string('name').notNullable()
    table.string('kind').notNullable()
    table.string('step_id').notNullable()
    table.string('status').notNullable()
    table.text('input')
    table.text('output')
    table.text('error')
    table.text('events')
    table.integer('attempts').notNullable()
    table.string('worker_group')
    table.bigInteger('wake_at')
    table.string('parallel_group')
    table.bigInteger('enqueued_at')
    table.bigInteger('started_at').notNullable()
    table.bigInteger('finished_at').notNullable()
    table.primary(['run_id', 'seq'])
    table.index(['run_id', 'name'], 'durable_checkpoints_name_idx')
  })
  ```

- The real schema declares both columns —
  `packages/adonis/src/stores/lucid-schema.ts:101-102`:

  ```ts
  table.bigInteger('last_heartbeat_at');
  table.text('heartbeat_progress');
  ```

  and carries an in-place auto-migration for existing installs at
  `lucid-schema.ts:114-121`.

- The writer — `packages/adonis/src/stores/lucid.ts:138-151`:

  ```ts
  async recordStepHeartbeat(
    runId: string, seq: number, at: Date, progress?: unknown,
  ): Promise<void> {
    await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', seq)
      .update({
        last_heartbeat_at: at.getTime(),
        heartbeat_progress: progress === undefined ? null : JSON.stringify(progress),
      });
  }
  ```

- **The functions the stub should delegate to already exist and are already
  public API** — `packages/adonis/src/index.ts:81`:

  ```ts
  export { DURABLE_TABLES, createDurableTables, dropDurableTables } from './stores/lucid-schema.js';
  ```

  with signatures at `lucid-schema.ts:32` and `:176`:

  ```ts
  export async function createDurableTables(db: Database, connectionName?: string): Promise<void>
  export async function dropDurableTables(db: Database, connectionName?: string): Promise<void>
  ```

- The stub is a Adonis stub template — its first lines are the codemod header,
  and the body is emitted verbatim into the user's migrations directory:

  ```
  {{{
    exports({ to: app.migrationsPath(`${new Date().getTime()}_create_durable_tables.ts`) })
  }}}
  import { BaseSchema } from '@adonisjs/lucid/schema'
  ```

- Repo conventions: conventional commits; vitest; changesets for user-visible
  changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Build (copies stubs) | `pnpm --filter @adonis-agora/durable build` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Changeset | `pnpm changeset` | creates a file in `.changeset/` |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/stubs/database/migrations/create_durable_tables.stub`
- `packages/adonis/test/migration-stub-schema.spec.ts` (create)
- `.changeset/<generated>.md` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/src/stores/lucid-schema.ts` — it is the correct source of
  truth. Do not edit the schema itself; this plan only makes the stub follow it.
- `packages/adonis/stubs/database/migrations/create_durable_transport_tables.stub` —
  the transport tables are a separate concern with their own (also duplicated)
  DDL. Converting it is a reasonable follow-up but doubles the blast radius
  here; leave it.
- `packages/adonis/src/stores/lucid.ts` — the writer is correct.
- Any change to `DURABLE_TABLES` names.

## Git workflow

- Branch: `fix/migration-stub-single-source-of-truth`
- One commit; message style: conventional commits, e.g.
  `fix: migration stub delegates to createDurableTables instead of duplicating DDL`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the delegation is actually viable

Before rewriting anything, verify that `createDurableTables` can run inside a
Lucid migration. Read `packages/adonis/src/stores/lucid-schema.ts:32-60` and
check what it expects as its `db` argument and whether it performs its own
`hasTable` / `hasColumn` guards (it does carry auto-migration logic at
`:114-121`, which implies it is idempotent — confirm this).

Inside a `BaseSchema` migration, the Lucid `Database` instance is reachable as
`this.db`. Confirm that is the same shape `createDurableTables` expects.

If `createDurableTables` cannot be called from a migration context — for
example if it requires a service-container-resolved instance that is not
available there — **STOP and report**. In that case the fallback is to fix only
the two missing columns in the hand-written DDL and file the deduplication as a
follow-up, but that decision is the operator's, not yours.

**Verify**: you can state, in one sentence, what `createDurableTables` needs and
that a migration can supply it.

### Step 2: Rewrite the stub body to delegate

Replace the hand-written `up()` and `down()` bodies with calls to the exported
functions, keeping the stub header and the import line shape intact. The
resulting migration should read roughly:

```ts
import { BaseSchema } from '@adonisjs/lucid/schema'
import { createDurableTables, dropDurableTables } from '@adonis-agora/durable'

export default class extends BaseSchema {
  async up() {
    await createDurableTables(this.db)
  }

  async down() {
    await dropDurableTables(this.db)
  }
}
```

Update the file's doc comment so it no longer describes a hand-maintained
schema — say that the tables are created by the package's own schema builder so
the migration and the `autoSchema` path can never disagree.

Keep the `{{{ exports({ to: ... }) }}}` header exactly as it is.

**Verify**: `pnpm --filter @adonis-agora/durable build` → exit 0, and
`cat packages/adonis/dist/stubs/database/migrations/create_durable_tables.stub`
shows your new body (the build copies stubs; confirm the copy happened).

### Step 3: Add a test that pins stub and schema together

Create `packages/adonis/test/migration-stub-schema.spec.ts`. The goal is a test
that fails if the stub and the real schema ever diverge again.

Because the stub now delegates rather than duplicating, the strongest available
assertion is structural: read the stub file and assert that it calls
`createDurableTables` and `dropDurableTables` and does **not** contain a
`createTable(` call. That directly encodes "the stub must not hand-write DDL".

Additionally — and this is the part that would have caught the original bug —
assert that the schema builder produces a checkpoints table containing
`last_heartbeat_at` and `heartbeat_progress`. Run `createDurableTables` against
the in-memory SQLite harness the existing store specs use (see
`packages/adonis/test/engine/stores/` for the setup pattern) and assert both
columns exist via Lucid's `hasColumn`.

**Verify**: `pnpm test` → exit 0 with the new spec passing.

### Step 4: Prove the test detects the drift

Temporarily comment out `table.bigInteger('last_heartbeat_at');` in
`src/stores/lucid-schema.ts:101`, re-run the new spec, and confirm the
column assertion **fails**. Restore the line.

Then temporarily restore a `createTable(` call in the stub and confirm the
structural assertion **fails**. Restore the stub.

Report both observations. Skipping this step means shipping a test that may
assert nothing.

**Verify**: both mutations fail the spec; after restoring, `pnpm test` → exit 0.

### Step 5: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **patch** bump. Describe it as a fix,
and state the user-facing consequence explicitly: apps provisioned via
`node ace configure` + `migration:run` were missing the step-heartbeat columns,
so step liveness silently did not work; new migrations now create the full
schema.

Also note in the changeset that **existing** installs provisioned via the old
stub need the columns added — `createDurableTables` is idempotent and carries
the in-place auto-migration at `lucid-schema.ts:114-121`, so re-running it
covers them, but users who disabled `autoSchema` should be told to run the new
migration.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- New file: `packages/adonis/test/migration-stub-schema.spec.ts`.
  - Case 1: the stub calls `createDurableTables` and `dropDurableTables`.
  - Case 2: the stub contains no `createTable(` call.
  - Case 3 (the regression): after `createDurableTables`, the checkpoints table
    has `last_heartbeat_at`.
  - Case 4: after `createDurableTables`, the checkpoints table has
    `heartbeat_progress`.
- Structural pattern: the SQLite harness used by the specs under
  `packages/adonis/test/engine/stores/`.
- Mutation check (Step 4) is required.
- Verification: `pnpm test` → all pass, including 4 new cases.

## Done criteria

ALL must hold:

- [ ] `grep -c "createTable(" packages/adonis/stubs/database/migrations/create_durable_tables.stub` returns `0`
- [ ] `grep -n "createDurableTables" packages/adonis/stubs/database/migrations/create_durable_tables.stub` returns a match
- [ ] The `{{{ exports({ to: ... }) }}}` header is unchanged
- [ ] `packages/adonis/test/migration-stub-schema.spec.ts` exists and passes
- [ ] The mutation checks in Step 4 were performed and both failed as expected
- [ ] `pnpm --filter @adonis-agora/durable build` exits 0 and the stub is copied to `dist/stubs/`
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (or only the known `deps.spec.ts` failure documented in plan 001 remains)
- [ ] A changeset file exists in `.changeset/` and mentions the existing-install upgrade note
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `createDurableTables` cannot be invoked from a `BaseSchema` migration (Step 1).
- The stub already delegates to `createDurableTables` — someone fixed this.
- Importing `@adonis-agora/durable` from inside a generated user migration
  creates a circular or unresolvable import in a real consuming app. If you
  cannot verify this either way, report it as an open question rather than
  guessing — a broken generated migration is worse than the current bug.
- `dropDurableTables` drops tables in an order that violates foreign-key
  constraints the hand-written `down()` was carefully ordering around. Compare
  the two orderings before accepting the delegation.

## Maintenance notes

- The transport tables stub
  (`create_durable_transport_tables.stub`) still hand-copies its DDL and has the
  same structural risk. It also lacks an index with `claimed_by` as a leading
  column, which the claim query at `src/transports/db.ts:478-483` filters on —
  a separate performance finding. Both are deliberate follow-ups.
- A reviewer should check that the stub header block is byte-identical and that
  the generated migration would actually run in a fresh app.
- If `DURABLE_TABLES` ever gains a table, the stub now picks it up for free —
  that is the point of this change.

# Plan 008: Stop the published migration from omitting the step-heartbeat columns

> **Supersedes `plans/004-migration-stub-single-source-of-truth.md`**, whose
> central approach was disproved during execution. See "What plan 004 got wrong"
> below — read it before you start, it will save you the same dead end.
>
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
- **Effort**: S (fallback) / M (shared-source path)
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29 (rewritten after 004 was blocked)

## Why this matters

The published migration stub creates `durable_step_checkpoints` **without**
`last_heartbeat_at` and `heartbeat_progress`, but
`LucidStateStore.recordStepHeartbeat` writes both columns on every step beat.
The auto-schema path (`autoSchema: true`, the default) creates them; the
migration path does not.

So an app provisioned the documented way — `node ace configure` +
`migration:run`, which is also the only path when `autoSchema: false` — issues an
UPDATE against columns that do not exist. The engine swallows the failure, so
step liveness silently never appears in the dashboard or in `durable:runs
--stale`, with no error anywhere.

This is the second instance of this drift (`parallel_group` was handled the same
way before), which is why the ideal fix is one source of truth rather than a
patched copy. **But the bug must get fixed either way** — this plan guarantees
that, and treats the deduplication as the better outcome rather than a
precondition.

## What plan 004 got wrong

Plan 004 told the executor to rewrite the stub as
`await createDurableTables(this.db)`. That cannot work, and the executor
correctly stopped rather than forcing it. Verified independently:

- `createDurableTables(db: Database, connectionName?)` at
  `packages/adonis/src/stores/lucid-schema.ts:32` internally does
  `db.connection(connectionName).schema` — it needs the Lucid **`Database`
  manager**.
- Inside a migration, `BaseSchema.db` is typed `QueryClientContract`
  (`@adonisjs/lucid/build/src/schema/main.d.ts:10`), and `QueryClientContract`
  has **no** `.connection()` method at all (grep over its type declaration
  returns zero matches).
- The migration runner resolves the client *before* constructing the schema
  class, so a migration never receives the manager.

`createDurableTables(this.db)` would fail to type-check and throw
`this.db.connection is not a function` at runtime.

What plan 004 also got wrong, structurally: it gated the *entire* fix on the
deduplication working, so when the design failed, the missing-columns bug went
unfixed too. This plan inverts that.

## Current state

- **The stub's checkpoints table** —
  `packages/adonis/stubs/database/migrations/create_durable_tables.stub:37-57`.
  No heartbeat columns:

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

- **The real schema has both** — `packages/adonis/src/stores/lucid-schema.ts:101-102`:

  ```ts
  table.bigInteger('last_heartbeat_at');
  table.text('heartbeat_progress');
  ```

  with an in-place auto-migration for existing installs at `:114-121`.

- **The writer** — `packages/adonis/src/stores/lucid.ts:144-151` updates both
  columns on every beat, and the engine swallows the resulting error.

- **What a migration actually offers** (from the same `.d.ts`): `BaseSchema`
  exposes `get schema(): Knex.SchemaBuilder`, and its calls are *tracked and
  executed later* ("All calls to `schema` and `defer` are tracked to be executed
  later"). That deferral is the thing to be careful about in Step 2 — an
  `await hasTable(...)` inside a migration does not behave like it does in the
  auto-schema path.

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

**In scope**:
- `packages/adonis/stubs/database/migrations/create_durable_tables.stub`
- `packages/adonis/src/stores/lucid-schema.ts` (only if you take the Step 2
  shared-source path)
- `packages/adonis/test/migration-stub-schema.spec.ts` (create)
- `.changeset/<generated>.md` (create)

**Out of scope**:
- `packages/adonis/src/stores/lucid.ts` — the writer is correct.
- `create_durable_transport_tables.stub` — same duplication problem, separate
  scope.
- Any change to `DURABLE_TABLES` names.
- Do **not** attempt `createDurableTables(this.db)`. It is disproved above.

## Git workflow

- Branch: continue on `advisor/durable-wave-1` if it exists, else
  `fix/migration-stub-heartbeat-columns`
- One commit; message style: conventional commits, e.g.
  `fix: migration stub creates the step-heartbeat columns`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the bug first, unconditionally

Add the two missing columns to the stub's `durable_step_checkpoints` block,
matching `lucid-schema.ts:101-102` exactly in type and nullability:

```ts
table.bigInteger('last_heartbeat_at')
table.text('heartbeat_progress')
```

Place them where they sit in `lucid-schema.ts` relative to the other columns, so
the two definitions read in the same order.

This is the whole user-facing fix. Everything after this step is about making
the drift not recur — valuable, but secondary. **Commit this step on its own**
so the bug fix is not hostage to the rest.

**Verify**: `grep -c heartbeat packages/adonis/stubs/database/migrations/create_durable_tables.stub`
returns `2`.

### Step 2: Attempt the shared source of truth

Now try to make the two definitions impossible to diverge. The approach that
fits what a migration actually offers:

Extract the DDL body of `createDurableTables` into an internal function that
takes a **schema-builder factory** (`() => Knex.SchemaBuilder`) instead of a
`Database`. Then:

- the auto-schema path passes `() => db.connection(connectionName).schema`
  (preserving the existing "fresh builder per statement" comment at
  `lucid-schema.ts:34-36`, which exists because Knex's builder is stateful);
- the stub passes `() => this.schema`.

The complication to solve, not ignore: the auto-schema path guards every table
with `await conn().hasTable(...)`, and inside a migration those calls are
deferred rather than executed inline. A migration does not need the guards (it
runs once, and `down()` drops), so give the extracted function a way to skip
existence checks, and have the migration path use it.

Keep `createDurableTables` / `dropDurableTables` exported with their **current
signatures** — they are public API (`src/index.ts:81`). This is an internal
refactor behind them.

If you cannot make this work — in particular if the deferred-execution semantics
of `BaseSchema.schema` make the shared function misbehave — **stop at Step 1's
outcome, keep the columns fix, and go to Step 3**. Do not force it. Report what
blocked you. A correct patched copy plus a drift test is an acceptable
end state; a clever shared abstraction that subtly breaks migrations is not.

**Verify**: `pnpm typecheck` → exit 0, and `pnpm test` → exit 0 with the existing
store/conformance specs unaffected.

### Step 3: Add the drift test — required regardless of Step 2's outcome

Create `packages/adonis/test/migration-stub-schema.spec.ts`.

Its job is to fail when the stub and the real schema disagree about columns. It
must work whichever path Step 2 took.

The assertion that matters: **the set of column names the stub declares for
`durable_step_checkpoints` equals the set `createDurableTables` produces for it.**

A workable approach without a live database: read the stub file and
`lucid-schema.ts` as text, extract the `table.<type>('<name>')` column names from
each file's checkpoints block, and compare the two sets. That is crude but it
directly encodes the invariant that was violated twice, and it cannot pass while
a column is missing from one side.

If you took Step 2's shared path, a stronger assertion is available: run the
schema builder against the in-memory SQLite harness the existing store specs use
(see `packages/adonis/test/engine/stores/`) and assert `hasColumn` for both
heartbeat columns. Do that instead if it is available to you.

Either way, include an explicit assertion for `last_heartbeat_at` and
`heartbeat_progress` by name — those are the columns that were missing, and a
named assertion documents the regression better than a set comparison alone.

**Verify**: `pnpm test` → exit 0 with the new spec passing.

### Step 4: Prove the test detects the drift

Remove `table.bigInteger('last_heartbeat_at')` from the **stub**, re-run the new
spec, confirm it **fails**, and restore it.

Then remove the same line from **`lucid-schema.ts`**, re-run, confirm it fails
from that side too, and restore.

Both directions matter: the drift can start from either file, and a test that
only notices one direction will miss the next occurrence.

Report both observations.

**Verify**: both mutations fail the spec; with both restored, `pnpm test` →
exit 0.

### Step 5: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **patch** bump.

Describe the user-facing consequence: apps provisioned via `node ace configure`
+ `migration:run` were missing `last_heartbeat_at` and `heartbeat_progress`, so
step-level liveness silently did not work — no heartbeat data in the dashboard
or in `durable:runs --stale`. New migrations create both columns.

Add the upgrade note for **existing** installs: they need the columns added.
`createDurableTables` carries an in-place auto-migration (`lucid-schema.ts:114-121`)
so apps on `autoSchema: true` pick them up on next boot; apps with `autoSchema:
false` need a follow-up migration adding the two columns.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- New file: `packages/adonis/test/migration-stub-schema.spec.ts`.
  - Case 1: the stub declares `last_heartbeat_at`.
  - Case 2: the stub declares `heartbeat_progress`.
  - Case 3: the stub's checkpoints column set equals the schema module's.
- Mutation check (Step 4), both directions, is required.
- Verification: `pnpm test` → all pass.

## Done criteria

ALL must hold:

- [ ] The stub declares `last_heartbeat_at` and `heartbeat_progress` with the same types as `lucid-schema.ts:101-102`
- [ ] Step 1 is its own commit, so the bug fix stands alone
- [ ] `packages/adonis/test/migration-stub-schema.spec.ts` exists and passes
- [ ] The spec fails when a column is removed from the **stub** (Step 4)
- [ ] The spec fails when the same column is removed from **`lucid-schema.ts`** (Step 4)
- [ ] `createDurableTables` and `dropDurableTables` keep their current exported signatures
- [ ] `pnpm --filter @adonis-agora/durable build` exits 0 and the stub is copied into `dist/stubs/`
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] A changeset exists mentioning the existing-install upgrade path
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The stub already declares both heartbeat columns — someone fixed this.
- Step 2's refactor changes the *exported* signature of `createDurableTables` or
  `dropDurableTables`. They are public API; an internal refactor must stay
  internal.
- Step 2 breaks any existing store or conformance spec. Fall back to Step 1's
  outcome plus Step 3 rather than adjusting those specs to fit.
- `dropDurableTables`'s drop ordering would have to change to accommodate a
  shared implementation — foreign-key ordering there is load-bearing.
- You find yourself unable to write a Step 3 assertion that can actually fail.
  A drift test that cannot detect drift is the failure mode this whole plan
  exists to prevent.

## Maintenance notes

- **Step 2 is optional; Steps 1, 3 and 4 are not.** If the shared-source refactor
  is abandoned, say so plainly in your report and in the changeset — the next
  person should know the duplication is still there and now merely guarded.
- The transport tables stub (`create_durable_transport_tables.stub`) has the same
  two-sources-of-truth structure and has not been audited for drift. It also
  lacks an index with `claimed_by` as a leading column, which the claim query at
  `src/transports/db.ts:478-483` filters on. Both are separate follow-ups.
- A reviewer should check Step 4 specifically. Both directions of the mutation
  must have been run — a one-directional drift test is how `parallel_group` and
  then the heartbeat columns both slipped through.

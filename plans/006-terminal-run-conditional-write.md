# Plan 006: Stop terminal run states from being silently clobbered

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/src/engine.ts packages/adonis/src/interfaces.ts packages/adonis/src/stores/ packages/adonis/src/testing/in-memory-state-store.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-restore-local-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

A run's status is written with an unconditional blind patch. There is no status
predicate and no version column, so whichever write lands last wins — including
a write computed from a stale snapshot.

The codebase already knows this is a hazard: commit `af88875` ("late results
never resurrect terminal runs") fixed exactly this shape on the remote-result
path, and `settleRun`'s `suspended` branch carries a five-line comment
explaining the race and re-reading the run before writing. But that guard was
applied to **one** of three branches. The `completed` and `failed` branches
write unconditionally.

Concretely: an operator cancels a run. The cancel writes `cancelled` directly.
The run's in-flight turn, which started before the cancel and knows nothing
about it, finishes and writes `completed`. The cancel is silently undone, and
`notifyParent` tells the parent workflow the child succeeded. The operator's
stop button did nothing and the parent proceeds on a run that was stopped.

The durable guarantee this breaks is stated in `docs/concepts/durability.mdx`.

## Current state

- **No conditional write exists at the store layer.**
  `packages/adonis/src/interfaces.ts:268`:

  ```ts
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void>;
  ```

  `packages/adonis/src/stores/lucid.ts:90-101` — a blind patch:

  ```ts
  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const row = runPatchToRow(patch);
    await this.client().transaction(async (trx) => {
      // Knex throws on an empty `.update({})`; skip the UPDATE when no mapped column changed.
      if (Object.keys(row).length) {
        await trx.from(DURABLE_TABLES.runs).where('id', runId).update(row);
      }
      if ('searchAttributes' in patch) {
        await this.reindexAttributes(trx, runId, patch.searchAttributes);
      }
    });
  }
  ```

  `packages/adonis/src/testing/in-memory-state-store.ts:62-68` — same, no guard:

  ```ts
  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`run ${runId} not found`);
    const next = { ...existing, ...patch };
    this.runs.set(runId, next);
    if ('searchAttributes' in patch) this.reindexAttributes(runId, next.searchAttributes);
  }
  ```

- **The asymmetry in `settleRun`** —
  `packages/adonis/src/engine.ts:2171-2216`. The `completed` branch writes with
  no check:

  ```ts
  private async settleRun(run: WorkflowRun, outcome: RunOutcome): Promise<RunResult> {
    const updatedAt = new Date();
    if (outcome.kind === 'completed') {
      // Clear any error from an earlier failed-then-retried attempt — a completed run is a success.
      await this.store.updateRun(run.id, {
        status: 'completed',
        output: outcome.output,
        error: undefined,
        updatedAt,
      });
      ...
      this.notifyParent(run.id, { ok: true, value: outcome.output });
  ```

  the `failed` branch likewise:

  ```ts
    if (outcome.kind === 'failed') {
      await this.store.updateRun(run.id, { status: 'failed', error: outcome.error, updatedAt });
  ```

  and only the `suspended` branch guards — note the comment, which describes the
  exact race this plan closes for the other two:

  ```ts
    // This outcome was computed by a turn that started from a possibly-stale run snapshot. If the run
    // was cancelled WHILE that turn was still executing (e.g. `ctx.all`'s failFast cancelling a
    // sibling mid-turn — plain `cancel()` writes `cancelled` directly, without waiting for the target's
    // in-flight turn to notice), this now-stale "suspended" outcome must not resurrect it: re-check the
    // CURRENT persisted status right before writing and echo it instead of clobbering a real cancel.
    const latest = await this.store.getRun(run.id);
    if (latest?.status === 'cancelled') {
      return { runId: run.id, status: 'cancelled', error: latest.error };
    }
    await this.store.updateRun(run.id, { status: 'suspended', ... });
  ```

  Note that even this guard is a TOCTOU across the `await` — read-then-write is
  narrower than the race but does not eliminate it. A conditional write does.

- **The cancel side** — `packages/adonis/src/engine.ts:1829-1830`:

  ```ts
  const error = { message: 'cancelled' };
  await this.store.updateRun(runId, { status: 'cancelled', error, updatedAt: new Date() });
  ```

- **Two more callers with the same shape**, both reported but **not**
  independently verified by the advisor — treat these as leads to confirm, not
  as facts:
  - `sweepTimeouts` around `engine.ts:1177-1200` reportedly lists `running` +
    `suspended` runs then writes `status: 'cancelled'` unconditionally in a loop
    with awaits between iterations, so a run that completed mid-loop is flipped
    to `cancelled`.
  - `parkBlocked` around `engine.ts:2923-2924` reportedly checks `cancelled` and
    `completed` but not `failed`/`dead`.

  Read both before deciding whether they are in scope for this plan (see Step 4).

- The conformance suite that every store implementation must satisfy:
  `packages/adonis/src/testing-kit/state-store-conformance.ts`. Any contract
  change must be reflected there, because it is how third-party store adapters
  self-verify.

- Repo conventions: conventional commits; vitest; changesets. This package is
  `0.x`, so a contract addition is acceptable in a minor bump.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Targeted | `pnpm --filter @adonis-agora/durable test -- engine` | engine specs pass |
| Lint | `pnpm lint` | exit 0 |
| Changeset | `pnpm changeset` | creates a file in `.changeset/` |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/src/interfaces.ts` (add one method to the `StateStore` contract)
- `packages/adonis/src/stores/lucid.ts` (implement it)
- `packages/adonis/src/testing/in-memory-state-store.ts` (implement it)
- `packages/adonis/src/engine.ts` (route terminal writes through it)
- `packages/adonis/src/testing-kit/state-store-conformance.ts` (add contract cases)
- `packages/adonis/test/**` (new/updated specs)
- `.changeset/<generated>.md` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/src/stores/lucid-schema.ts` and the migration stubs — **do
  not add a version column.** A status-predicate compare-and-set needs no schema
  change, and adding one turns this into a migration for every existing install.
  If you conclude a version column is unavoidable, STOP and report.
- The lease/ownership methods (`tryLockRun`, `renewRunLock`, `releaseRunLock`).
  There is a separate, real finding that `releaseRunLock` takes no owner and
  that `renewRunLock`'s return value is discarded — it is **not** this plan.
  Mixing them makes the blast radius unreviewable.
- `resume()`'s admission of `failed` runs (`engine.ts:1087`). Also a separate
  reported finding; do not change it here.
- Any change to `WorkflowRun`'s shape.

## Git workflow

- Branch: `fix/terminal-run-conditional-write`
- Commit per logical unit (contract + implementations; then engine call sites;
  then tests). Message style: conventional commits, e.g.
  `fix: guard terminal run writes with a status compare-and-set`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a conditional-update method to the `StateStore` contract

In `packages/adonis/src/interfaces.ts`, alongside `updateRun` at line 268, add a
compare-and-set variant. Required semantics, documented in its doc comment:

- Signature shape: `updateRunIf(runId, expectedStatuses, patch)` returning
  `Promise<boolean>`.
- It applies `patch` **only if** the run's current persisted `status` is one of
  `expectedStatuses`.
- It returns `true` when the write was applied, `false` when the predicate did
  not match. It must not throw on a non-match — a non-match is a normal outcome.
- It must be atomic with respect to concurrent writers. A read-then-write in JS
  is **not** acceptable; the predicate must be part of the UPDATE statement.

Do not remove `updateRun`. Many non-terminal writes legitimately want a blind
patch, and removing it would be a gratuitous breaking change.

**Verify**: `pnpm typecheck` → fails only with "not implemented" errors on the
two store classes (expected at this point).

### Step 2: Implement it in both stores

`packages/adonis/src/stores/lucid.ts` — mirror the existing `updateRun`
structure, but add the status predicate to the `where` clause so the database
arbitrates:

```ts
await trx
  .from(DURABLE_TABLES.runs)
  .where('id', runId)
  .whereIn('status', expectedStatuses)
  .update(row);
```

Use the row count the update returns to produce the boolean. Keep the existing
empty-patch guard (`Knex throws on an empty .update({})`) and the
`searchAttributes` reindex behaviour — but only reindex when the write actually
applied.

`packages/adonis/src/testing/in-memory-state-store.ts` — same semantics: check
`existing.status` against `expectedStatuses`, apply and return `true`, or return
`false` without mutating.

**Verify**: `pnpm typecheck` → exit 0

### Step 3: Add conformance cases

In `packages/adonis/src/testing-kit/state-store-conformance.ts`, add cases that
every store implementation must satisfy:

1. `updateRunIf` applies the patch and returns `true` when the current status is
   in the expected set.
2. It returns `false` and leaves the row untouched when the status is not in the
   expected set.
3. Two sequential calls where the first transitions the run out of the expected
   set: the second returns `false` (this is the property the whole plan exists
   for).

These run against both the in-memory store and the Lucid store via the existing
conformance spec instantiations under `packages/adonis/test/`.

**Verify**: `pnpm test` → exit 0, and the conformance specs for **both** stores
include the new cases.

### Step 4: Route the terminal writes through it

In `packages/adonis/src/engine.ts`:

- `settleRun`'s `completed` branch: only write when the run is still in a
  non-terminal state. Use the conditional write; when it returns `false`, do
  **not** emit `run.completed` and do **not** call `notifyParent` with success —
  re-read the run and return its actual current status, mirroring what the
  `suspended` branch already does when it detects `cancelled`.
- `settleRun`'s `failed` branch: same treatment.
- `settleRun`'s `suspended` branch: replace the read-then-write with the
  conditional write, which subsumes the existing guard and closes its TOCTOU.
  Keep the existing "echo the current status" return behaviour.

Decide the expected-status set from the code, not from this plan: it is the set
of statuses from which the transition is legitimate. Do not guess — read the
status enum and the transitions the engine already performs.

Then read `sweepTimeouts` (~`engine.ts:1177-1200`) and `parkBlocked`
(~`engine.ts:2923-2924`). If they exhibit the same unconditional-terminal-write
shape, convert them too. If converting them requires reasoning about statuses
this plan has not enumerated, leave them and note it in your report — a partial
fix that is correct beats a complete one that is not.

**Verify**: `pnpm test` → exit 0.

### Step 5: Write the regression test

Add a spec (place it alongside the existing engine specs under
`packages/adonis/test/engine/`) that reproduces the operator-cancel race
deterministically:

1. Start a run whose workflow body suspends on a controllable promise.
2. While the turn is in flight, call `engine.cancel(runId)`.
3. Release the body so the turn completes and `settleRun` runs with its stale
   snapshot.
4. Assert the persisted run status is `cancelled`, **not** `completed`.
5. Assert the parent was **not** notified of success.

Use the in-memory store and the existing engine test harness (see
`packages/adonis/src/testing-kit/harness.ts` and how the specs under
`test/engine/` use it) rather than building a new one.

**Verify**: the new spec passes.

### Step 6: Prove the test detects the bug

Revert only the `completed` branch in Step 4 to its unconditional
`store.updateRun(...)` form, re-run the new spec, and confirm it **fails** with
the run ending as `completed`. Then restore the fix.

Report what you observed. This is the single most important verification in this
plan: the race is timing-dependent, and a test that does not actually reproduce
it is worse than no test because it licenses future regressions.

**Verify**: without the guard the spec fails; with it restored, `pnpm test` →
exit 0.

### Step 7: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **minor** bump (the `StateStore`
contract gained a method — third-party store adapters must implement it).
Describe both the fix and the contract addition, and state explicitly that
custom `StateStore` implementations need to add `updateRunIf`.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- Conformance (Step 3): 3 new cases in
  `packages/adonis/src/testing-kit/state-store-conformance.ts`, running against
  both the in-memory and Lucid stores.
- Regression (Step 5): the cancel-versus-completing-turn race, asserting the
  persisted status and the absence of a success notification to the parent.
- Mutation check (Step 6) is required.
- Structural pattern: existing specs under `packages/adonis/test/engine/`.
- Verification: `pnpm test` → all pass except the known out-of-scope
  `deps.spec.ts` failure documented in plan 001.

## Done criteria

ALL must hold:

- [ ] `updateRunIf` (or the agreed name) is declared in `packages/adonis/src/interfaces.ts`
- [ ] Both `stores/lucid.ts` and `testing/in-memory-state-store.ts` implement it
- [ ] The Lucid implementation puts the status predicate in the SQL `where`, not in JS — verify by reading the query
- [ ] `grep -n "store.updateRun(run.id, {" packages/adonis/src/engine.ts` shows no remaining **terminal-status** blind writes in `settleRun`
- [ ] 3 new conformance cases exist and pass for both stores
- [ ] The cancel-race regression spec exists and passes
- [ ] The mutation check in Step 6 was performed and the spec failed without the fix
- [ ] No schema migration was added (`git status` shows no change under `stubs/database/`)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (or only the known `deps.spec.ts` failure remains)
- [ ] A changeset exists, marked **minor**, mentioning the `StateStore` contract addition
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `settleRun`'s `completed` branch already guards its write — someone fixed this.
- You conclude an atomic status predicate cannot be expressed in the Lucid query
  builder across the dialects this package supports (SQLite / Postgres / MySQL).
  A JS read-then-write is **not** an acceptable fallback — report instead.
- The fix appears to require a version/revision column (out of scope, see Scope).
- The regression spec in Step 5 cannot be made to reproduce the race
  deterministically. Do not ship a flaky test or a test that passes for the
  wrong reason — report the difficulty.
- Converting `sweepTimeouts` or `parkBlocked` cascades into lease/ownership
  changes. Those belong to a different plan.

## Maintenance notes

- **Related findings deliberately left out of this plan**, so nobody assumes
  they were handled: (a) `releaseRunLock(runId)` takes no owner argument, so no
  store can enforce lease ownership on release, and the boolean returned by
  `renewRunLock` is discarded at `engine.ts:2124-2131` — together these allow a
  stalled worker to wipe a live lease held by another instance; (b) `resume()`
  admits `failed` runs at `engine.ts:1087`, which lets a late child signal
  replay a failed parent and re-run its saga compensations. Both are real,
  both were reported, neither is fixed here.
- Once `updateRunIf` exists, it is the right primitive for those fixes too.
- A reviewer should scrutinize the expected-status sets chosen in Step 4: too
  narrow silently drops legitimate transitions, too wide reintroduces the
  clobber. Each call site's set should be justifiable in one sentence.
- If a future contributor adds a new terminal status, every `updateRunIf`
  call site's expected set must be revisited.

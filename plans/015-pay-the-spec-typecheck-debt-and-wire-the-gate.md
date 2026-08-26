# Plan 015: Pay the 246-error spec type-check debt in three repos, then wire the gate

> Read fully before starting. This plan spans THREE repositories. Honor the STOP
> conditions.

## Status

TODO. Plan 014 stopped at its own step 1 because the advisor's measurement was an
artifact. This plan carries the corrected numbers.

## The corrected measurement — and how the wrong one happened

Every package's `tsconfig.json` omits its test directory from `include` **and**
excludes it explicitly:

- `adonis-durable/packages/adonis`: `exclude: ["**/*.spec.ts", "**/*.test.ts", "test/**", "dist/**"]`
- `adonis-telescope/packages/core`: `exclude: ["test/**", "dist/**"]`
- `adonis-agent/packages/adonis`: `exclude: ["**/*.spec.ts", "**/*.test.ts", "test/**", "dist/**"]`

`exclude` filters `include`. The advisor's probe added `test/**/*` to `include` and
read "0 errors" — zero because **zero spec files entered the program**. `--listFiles`
is what exposes it.

Re-measured with `exclude` reduced to `["dist/**"]` **and**
`types: ["node", "vitest/globals"]` (mandatory: durable's vitest sets
`globals: true` and 19 of its specs use bare `describe`/`it`; without it you measure
278 instead of 108 and mistake harness noise for debt):

| package | specs in program | errors |
|---|---|---|
| `durable/packages/adonis` | 189 | **108** |
| `telescope/packages/core` | — | **68** |
| `agent/packages/adonis` | 65 | **70** |
| `durable/packages/eslint-plugin` | — | **0** |
| `agent/packages/dashboard` | 1 | **0** |
| `telescope/packages/ui` | 5 of 6 specs | **0** |

**246 total.** Re-measure yourself and report your table before fixing anything.

## What the debt is (orientation, not a work order)

From the plan-014 audit of `durable/packages/adonis`:

- **Real shape drift.** `test/dashboard/handlers.spec.ts` (18 errors) types
  `Deps.engine` as the narrow `DashboardEngine` port while calling concrete
  `WorkflowEngine` methods (`.start`, `.waitForRun`) the port does not declare —
  green at runtime, a lie at the type level. `test/engine/transports/queue.spec.ts`
  passes a job literal missing `attempts`, now required on `JobData`.
  `test/engine/base-workflow.spec.ts` — 16 × `TS4114`, subclasses overriding without
  `override`.
- **A genuine library finding, and it is the interesting one.**
  `test/workflow-discovery.spec.ts` — 3 × `TS2511`: `new found[0]!.cls()` cannot be
  called because `discoverWorkflows` returns an **abstract** class constructor type.
  **Consumers cannot instantiate what that API hands back.** Fixing it is an `src`
  type change; see Scope.
- **A missing devDependency, not debt.** 1 × `TS7016` in
  `test/setup/sqlite-preflight.ts` — `durable/packages/adonis` has `better-sqlite3`
  but not `@types/better-sqlite3` (telescope/core has both). Add the devDep.
- Remainder: `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` strictness and
  untyped `container.make` results.

`telescope/core`'s 68: `TS18048` ×31, `TS2532` ×9, `TS2493` ×9, `TS2339` ×8. No API
drift found; concentrated in `test/alerts/alert_channel.spec.ts` and
`test/redaction/redact.spec.ts`, mostly `vi.mocked(fetch).mock.calls[0]` indexing
into a `[]`-typed tuple.

## The wiring, and the constraint that decides its shape

**A separate `tsconfig.tests.json` per package**, extending the package tsconfig,
with `noEmit`, `incremental: false`, `tsBuildInfoFile: null`, `include` widened with
the test glob, `exclude` reduced to `["dist/**"]`, and `types: ["node","vitest/globals"]`
where the package needs it. Then wire it into that package's `typecheck` script.

**Do NOT extend the base `include`.** Two reasons, both verified:

- **durable**: `tsconfig.build.json` (plan 012's emitting project) declares no
  `include`/`exclude` of its own and inherits both from `tsconfig.json`. Anything
  added to the base lands in `dist/` and ships to npm. A sibling project keeps
  `tsconfig.build.json` byte-identical and plan 012's buildinfo split intact.
- **telescope/core is worse**: its `build` is `tsc -p tsconfig.json` — the typecheck
  config **is** the emitting config, and `files: ["dist/"]` would publish compiled
  specs. Verify this before touching it.

Also: `durable/packages/adonis/tsconfig.type-test.json` already exists — a
tests-only project in exactly this shape, **wired to nothing**, referenced only by
`test/config_types.spec.ts`. Decide: widen and wire it, or replace it with
`tsconfig.tests.json` and delete it. Say which and why.

## Scope

**In scope, per repo:**
- `packages/*/tsconfig.tests.json` (new), `packages/*/package.json` scripts
- `packages/*/test/**` — the fixes
- `packages/adonis/package.json` in durable — `@types/better-sqlite3` devDep
- `turbo.json` — only if the wiring requires it
- `packages/adonis/src/workflow-discovery.ts` (durable) — **only** the abstract
  constructor return type, and only if you can do it without changing behaviour.
  This is the one `src` change allowed, because the type is wrong in a way that
  blocks consumers. If it needs more than a type adjustment, STOP and report.
- `.changeset/` — only for the `src` type change, if you make it

**Out of scope:**
- `adonis-authkit` (done: gate wired, ratchet at 292).
- Any behavioural change. Every fix must be type-level only. If a spec's assertion
  has to change to compile, that spec was asserting something false — report it
  rather than quietly adjusting it.
- `@ts-nocheck`, `@ts-expect-error`, new `exclude` entries, `skipLibCheck` widening.
  If you cannot fix an error honestly, leave it and report it.

## Git workflow

- **durable**: worktree `adonis-durable-worktrees/advisor-wave-1`, branch
  `advisor/durable-wave-1`.
- **agent**: worktree `adonis-agent-worktrees/advisor-wave-1`, branch
  `advisor/agent-wave-1`.
- **telescope**: main checkout on `master`. **Create `advisor/telescope-wave-2`
  first.**
- Do NOT push, merge or rebase. Commit per package.

## Commands

```
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # mise, NOT nvm
```

Run vitest **directly** (`npx vitest run`), never turbo — it serves cached greens in
these repos. `pnpm lint` is `biome check .`; `--force` is not a valid flag.

**Baselines:** durable `984 passed | 19 skipped`; agent `packages/adonis` 557 with
backends / 537 + 20 skipped without, `packages/dashboard` 81; telescope core **570**
+ ui 41 (measure and report — the advisor's earlier 573 was wrong).

## Steps

1. Re-measure all six packages with the corrected harness. Report the table. If a
   number differs materially from this plan's, say so before proceeding.
2. **Wire the three already-clean targets first** (`durable/eslint-plugin`,
   `agent/dashboard`, and `telescope/ui`'s uncovered `src/server/paths.spec.ts`).
   They are pure wiring and give you the mechanism before you spend effort on debt.
3. **Prove the gate fails** in each repo: a deliberate type error in one spec, that
   repo's typecheck must fail naming the spec file; revert; must pass. **Report every
   run.** A gate nobody proved can fail is the pattern this plan exists to close.
4. **Prove coverage, not success**: `tsc -p <config> --listFiles`, count files under
   the test dir, before and after. Zero-before / non-zero-after is the evidence.
5. Pay the debt, package by package, smallest first (telescope 68 → agent 70 →
   durable 108). Commit per package.
6. Re-run each repo's suite against its baseline. **A type fix must not move a test
   count.** If one does, that fix changed behaviour — back it out and report.

## Done criteria

- [ ] Step 1's measured table reported and reconciled
- [ ] All six packages type-check their tests via a wired script
- [ ] Step 3 proved the gate fails in all three repos (every run reported)
- [ ] Step 4's `--listFiles` evidence per project
- [ ] 246 → 0, or a per-package residual with an honest reason for each
- [ ] No suppression of any kind
- [ ] durable's `tsconfig.build.json` still emits no specs; plan 012's buildinfo split intact
- [ ] telescope/core's emitting config still emits no specs
- [ ] The `type-test.json` decision stated
- [ ] `@types/better-sqlite3` added to durable
- [ ] The `discoverWorkflows` abstract-constructor finding fixed or reported
- [ ] Every suite equals its baseline — no test count moved
- [ ] Telescope work on a NEW branch, not `master`
- [ ] Nothing pushed; nothing outside the in-scope list modified

## STOP conditions

- A measured count differs materially from the table above.
- Adding tests to any checked set pulls them into an emitting project.
- A fix requires changing a spec's assertion — report the spec; it was asserting
  something false.
- `discoverWorkflows`'s return type needs more than a type adjustment.
- Any suite's test count moves.

## Maintenance notes

- **The wrong measurement is the lesson, and it happened twice in opposite
  directions.** In `authkit` the advisor over-counted 12× by omitting `bin/**/*`
  (japa's `assert` arrives via a module augmentation that only enters through
  `bin/test.ts`). Here it under-counted to zero by ignoring `exclude`. Both times the
  fix was to check *what entered the program* before reading the count as debt —
  which is exactly what plan 014's own step 5 prescribed and its step 1 skipped.
- **`agent/packages/adonis`'s 70 were found the hard way.** An executor writing five
  new RAG specs had 4 real type errors on first write — including a `count` helper
  colliding with a newly added `QdrantClientLike.count?` — while every test passed
  green. That is the cost this gate removes.

# Plan 011: Make `configure-export.spec.ts` actually run in CI

> Read this plan fully before starting. Honor the STOP conditions. Verify every
> excerpt against the live file before acting — if an excerpt does not match,
> treat it as a STOP condition **for that excerpt**: re-read the file, use what
> is actually there, and note the discrepancy in your report. Do not halt the
> whole task over a stale line number.

## Status

TODO

## Why this matters

`packages/adonis/test/configure-export.spec.ts` exists to catch one specific
regression that already shipped once: `configure` being defined but not
reachable from the package **main**, which makes
`node ace configure @adonis-agora/durable` a silent no-op. It asserts against the
built `dist/src/index.js` rather than `src/index.ts` precisely because a
source-level test passed while the bug was live.

**It never runs in CI.** Three facts, each verified:

1. `packages/adonis/test/configure-export.spec.ts:15-16` — when
   `dist/src/index.js` is absent the whole thing degrades to
   `it.skip('dist/ does not exist — run … build first')`.
2. `turbo.json:8-9` — the `test` task is `"dependsOn": ["^build"]`. The caret
   means **upstream** packages' builds. This package's own `build` is never
   triggered by `turbo run test`.
3. `.github/workflows/release.yml` — the steps are `pnpm install`, `pnpm lint`,
   `pnpm typecheck`, `pnpm test`. `grep -n build .github/workflows/release.yml`
   returns **nothing**. No build happens before the tests.

So on a fresh CI checkout `dist/` does not exist, the guard fires, and the spec
skips. It only appears to work locally because a developer's `dist/` is left over
from an earlier build.

The consequence is not "one test doesn't run". Plan 007 just made `pnpm test` a
gate on the changesets publish step. A green release run currently does **not**
mean the `configure` export survived — it means the check was skipped. The guard
against the exact bug that shipped is absent precisely where it would have to
fire.

This is the second instance in this codebase of the same failure shape: a check
that degrades to a no-op when a precondition is missing, and is therefore
invisible when it is missing. The other is `accountStore?` in adonis-authkit
(that repo's plan 010). Naming the pattern is part of the point of this plan.

## Current state

`turbo.json:4-11`:

```json
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
```

Root `package.json:17-18`:

```json
    "build": "turbo run build",
    "test": "turbo run test",
```

`packages/adonis/package.json:105,108`:

```json
    "build": "tsc -p tsconfig.json && pnpm run copy:stubs",
    "test": "vitest run --passWithNoTests",
```

The spec's guard, `packages/adonis/test/configure-export.spec.ts:15-16`:

```ts
  if (!existsSync(distIndexPath)) {
    it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
  } else {
```

## Commands you will need

```
cd /home/dudousxd/personal/oss/adonis/adonis-durable-worktrees/advisor-wave-1
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # NOT nvm; this box uses mise
```

Node 22 is mandatory — the machine default is 26 and `better-sqlite3` is built
for 22; the sqlite preflight will abort the suite and tell you so.

**Turbo is not trustworthy for verifying this change.** It does not track the
dist artifact or the native binary as inputs and will serve cached results. Two
false greens have already been produced this way in this repo family. Use
`--force` whenever you invoke turbo, and prefer calling `vitest` directly
(`cd packages/adonis && npx vitest run …`) for the spec-level checks.

## Scope

**In scope** (the only files you should modify):
- `turbo.json` — **only** if you take route (a) below
- `packages/adonis/test/configure-export.spec.ts` — the CI guard, route (b)
- `.github/workflows/release.yml` — **only** if you take route (c)

Take **route (a) plus route (b)**. See Step 2 for why, and for what to do if (a)
turns out not to work.

**Out of scope** (do NOT touch, even though they look related):
- The 60 s `testTimeout` added by plan 010 (commit `14268c4`). It is correct and
  independently justified. Leave it.
- `packages/adonis/package.json`'s scripts.
- The `.github/workflows/ci.yml` (or equivalent non-release CI workflow), unless
  Step 1 shows it has the same gap — in which case report it, and fix it only if
  the fix is the identical one-line change you already made to `release.yml`.
  Anything larger is a separate plan.
- Any other spec. If other specs also depend on build artifacts, list them in
  your report; do not fix them here.

## Git workflow

- Branch: stay on `advisor/durable-wave-1` (already checked out in the worktree).
  Do NOT create a branch, do NOT push, do NOT merge.
- One commit per route you take. Conventional commits, e.g.
  `fix(ci): build before test so the dist-import spec cannot skip`.
- No changeset — none of this changes shipped code.

## Steps

### Step 1 — Prove the skip, and check the other workflow

Reproduce the actual CI condition. From the worktree:

```
mv packages/adonis/dist /tmp/durable-dist-backup       # or `git stash` equivalent — just move it
cd packages/adonis && npx vitest run test/configure-export.spec.ts
```

You must see the test **skipped**, not failed, not passed. Record the exact
output. Then restore `dist/` immediately (`mv` it back) and confirm the spec
passes again.

Also: `ls .github/workflows/` and check every workflow that runs `pnpm test`.
Report which ones lack a build step. `release.yml` is known-bad; there may be a
CI workflow with the same gap.

If the spec does **not** skip with `dist/` absent, STOP — the premise is wrong.

### Step 2 — Route (a): make the test task depend on this package's own build

In `turbo.json`, change the `test` task's `dependsOn` from `["^build"]` to
`["build", "^build"]` — `build` (no caret) means *this package's* build task,
`^build` keeps the upstream builds it already had. Both are needed; dropping
the caret would break packages that depend on siblings' output.

Verify:

```
rm -rf packages/adonis/dist
pnpm test --force 2>&1 | tee /tmp/durable-test-run.log
```

Then confirm two things in that log:
- `packages/adonis/dist/src/index.js` exists afterwards (`ls` it), i.e. the build
  actually ran as part of `test`
- the `configure hook export` test **ran and passed** — it must not appear as
  skipped. Grep the log.

If route (a) does not produce a build (turbo config semantics differ from the
above), do not fight it: report exactly what you tried and what happened, take
route (c) instead, and still do route (b).

### Step 3 — Route (b): fail instead of skipping when CI is set

Route (a) fixes the cause. Route (b) makes the failure mode visible if anyone
ever undoes it — which is the whole lesson of this finding.

Change the guard so that a missing `dist/` is a **hard failure under CI** and
remains a skip for local developers:

- when `dist/src/index.js` is absent **and** `process.env.CI` is set: register a
  test that fails with a message explaining that the build must run before the
  tests, and that skipping here silently disables the only guard against the
  `configure`-not-exported regression
- when it is absent and `CI` is not set: keep today's `it.skip` with today's
  message

Write a comment above the guard explaining why a skip is dangerous here
specifically. Reference this file's own history: the bug it guards against
already shipped once.

### Step 4 — Prove route (b) both ways

Two runs, both with `dist/` moved aside, both invoking `vitest` directly (not
turbo):

1. `CI=1 npx vitest run test/configure-export.spec.ts` → must **FAIL** with your
   message
2. `npx vitest run test/configure-export.spec.ts` (no `CI`) → must **SKIP**

Restore `dist/`, run once more → must **PASS**. Report all three verbatim.

If your shell already exports `CI`, unset it explicitly for run 2 (`env -u CI …`)
and say that you did.

### Step 5 — Route (c), only if Step 2 failed

Add a `- run: pnpm build` step to `.github/workflows/release.yml`, between
`pnpm install --frozen-lockfile` and `pnpm lint`.

**Whatever you do, do not disturb these three lines** — verify each still greps
to exactly 1 afterwards: `id-token: write`, `npm@^11.5.1`, `NODE_AUTH_TOKEN: ''`.

### Step 6 — Full verification

`pnpm lint`, `pnpm typecheck`, and the full suite. Baseline on this branch is
**970 passed | 19 skipped | 0 failed**.

Note the skipped count: if your change made the `configure` spec actually run
where it previously skipped, the numbers move. Report the before and after and
explain the delta rather than just asserting green.

## Done criteria

ALL must hold:

- [ ] Step 1 demonstrated the skip with `dist/` absent (output recorded)
- [ ] Every workflow running `pnpm test` was checked for a missing build step; findings reported
- [ ] `turbo run test` (or the release workflow) now builds this package before testing it
- [ ] With `dist/` absent and `CI` set, the spec FAILS
- [ ] With `dist/` absent and `CI` unset, the spec SKIPS
- [ ] With `dist/` present, the spec PASSES
- [ ] Plan 010's 60 s timeout is untouched
- [ ] `id-token: write`, `npm@^11.5.1` and `NODE_AUTH_TOKEN: ''` each still grep to exactly 1 in `release.yml`
- [ ] `pnpm lint` exits 0, `pnpm typecheck` exits 0
- [ ] Full suite green; the passed/skipped delta is explained
- [ ] No changeset added
- [ ] No files outside the in-scope list modified (`git status --porcelain`)

## STOP conditions

Stop and report back (do not improvise) if:

- The spec does not skip when `dist/` is absent.
- Making `test` depend on `build` creates a dependency cycle, or makes the suite
  dramatically slower in a way that would hurt the inner development loop
  (report the timing; a full rebuild on every `pnpm test` is a real cost worth a
  human decision).
- You find that other specs also silently depend on build artifacts. List them;
  fixing them is a separate plan.
- Route (a) and route (c) both fail.

## Test plan

No new spec file. The verification *is* the three-state proof in Step 4 (fail
under CI / skip locally / pass when built). That triple is what distinguishes
this fix from one that merely looks applied.

## Maintenance notes

- **The pattern, which is worth more than this fix.** Twice in one audit session
  a safety check degraded to a no-op when a precondition was missing, and in both
  cases the degradation was deliberate and sensible in isolation: `it.skip` so
  developers without a build are not blocked, and an optional `accountStore?` so
  hosts with minimal stores are not broken. Both made the check invisible exactly
  where it mattered. When you write a check that can degrade, add a second check
  that the first one ran — or make the degradation loud in the environment where
  the check is load-bearing.
- Any future spec asserting against `dist/` inherits this problem. Prefer
  extending this spec over adding a new one with its own guard.

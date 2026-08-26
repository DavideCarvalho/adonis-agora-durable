# Plan 014: Type-check the specs — durable and telescope (and why this one is cheap)

> Read fully before starting. This plan spans TWO repositories. Honor the STOP
> conditions.

## Status

TODO. Closes, for the vitest-based siblings, the gap `adonis-authkit` plans 017
and 018 closed for its nine packages. Aviary landed the same fix on `nestjs-agent`
in July (*"ci: type-check the specs, which nothing has ever done"*), so this is
family-wide, not a local oversight.

## The gap

No package's `tsconfig.json` `include` lists its test directory. Verified:

| package | `include` | specs |
|---|---|---|
| `adonis-durable` `packages/adonis` | `src`, `providers`, `commands`, `configure.ts`, `stubs/main.ts` | many |
| `adonis-durable` `packages/eslint-plugin` | `src/**/*.ts` | few |
| `adonis-telescope` `packages/core` | `src`, `providers`, `configure.ts`, `stubs/main.ts` | 59 |
| `adonis-telescope` `packages/ui` | **no `include` at all** | — |

`packages/ui` is the exception: with no `include`, tsc takes everything under the
project dir, so its tests are already covered. Confirm that rather than assuming
it, and leave it alone if so.

So a type error in a spec fails no gate: not `pnpm typecheck`, not `pnpm lint`, not
CI. A test can assert against a shape the library no longer has and stay green
forever — which is the opposite of what tests are for. `adonis-authkit` found two
real instances the day its gate went live, including a spec passing a config key
that had been removed and silently ignored.

## Why this is cheap, and why you should still verify

**The advisor measured it: 0 errors in all four packages.**

```
telescope/core    0
durable/adonis    0
agent/dashboard   0   (that repo is not in this plan's scope)
agent/adonis      0   (idem)
```

Measured by cloning each `tsconfig.json`, adding `test/**/*` and `tests/**/*`, and
running `tsc --noEmit`.

The reason it is 0 here and 332 in `authkit-server`: these repos use **vitest**,
whose `expect` is *imported* by each spec, while japa's `assert` arrives via a
module augmentation that only enters the program through `bin/test.ts`. Leave `bin`
out of a japa project's checked set and every `assert.equal(...)` becomes an error
— which is exactly how the advisor first measured 372 instead of 30 there.

**Re-measure anyway before you wire anything**, and report your numbers. The
authkit lesson was that an unverified count is worthless, and it cuts both ways: a
0 you did not produce yourself is as unreliable as a 372.

So this is a **real gate from day one** — no ratchet, no baseline script, no
`BASELINE` constant. If your measurement disagrees and there is real debt, STOP
and report rather than inventing a ratchet under this plan.

## Current state

Read before editing:
- Both repos' root `turbo.json` — the `typecheck` task, and (in durable) note that
  plan 012 changed `typecheck`'s `outputs` to the literal `.typecheck.tsbuildinfo`
  and gave `build` no buildinfo at all. **Do not break that.** If adding `test` to
  the checked set changes which buildinfo gets written, say so.
- Each package's `package.json` `typecheck` script.
- `adonis-durable`'s `packages/adonis/tsconfig.build.json` (from plan 012) — the
  emitting project. Tests must NOT enter it; emitting compiled specs into `dist/`
  would ship them.
- `adonis-telescope/packages/ui/tsconfig.json` — the no-`include` case.

## Commands you will need

```
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # NOT nvm; mise

cd /home/dudousxd/personal/oss/adonis/adonis-durable-worktrees/advisor-wave-1
pnpm build && pnpm typecheck && pnpm lint
cd packages/adonis && npx vitest run        # NOT turbo — it serves cached greens

cd /home/dudousxd/personal/oss/adonis/adonis-telescope
pnpm typecheck && pnpm lint && pnpm test
```

**Baselines.** durable: `984 passed | 19 skipped` (verified after plan 013).
telescope: **measure it yourself and report** — the advisor's last figure was 573 +
41, and it predates this wave.

`pnpm lint` is `biome check .` in both — not a turbo task, `--force` is invalid.

## Scope

**In scope:**
- `adonis-durable`: `packages/adonis/tsconfig.json` (or a new `tsconfig.tests.json`),
  `packages/eslint-plugin/tsconfig.json`, those packages' `package.json` scripts
- `adonis-telescope`: `packages/core/tsconfig.json` and its `package.json` script;
  `packages/ui` only if it turns out not to be covered
- test files in both, **only** if your re-measurement finds errors
- `turbo.json` in either repo, only if the wiring requires it

**Out of scope:**
- `adonis-agent`. Same gap, measured 0 in both its packages, but another executor
  is working on that branch right now. A separate dispatch will take it; do not
  touch it.
- `adonis-authkit`. Done.
- Any `src` change.
- Plan 012's build/buildinfo split in durable. Preserve it.

## Git workflow

- `adonis-durable`: worktree `adonis-durable-worktrees/advisor-wave-1`, branch
  `advisor/durable-wave-1`.
- `adonis-telescope`: **main checkout**, currently on `master` at `3a9722b`.
  **Create a branch `advisor/telescope-wave-2` before touching anything.**
- Do NOT push, merge or rebase in either.
- Commit per repo.

## Steps

### 1 — Re-measure both repos, report the table

Against this plan's. If any number is not 0, stop and report before wiring.

### 2 — Wire durable

Decide: extend `include`, or a separate `tsconfig.tests.json` like
`authkit-server`'s. **Say why.** The constraint that decides it: `tsconfig.json` is
the base that `tsconfig.build.json` extends, so anything you add to its `include`
must not reach the emitting build. Check `tsconfig.build.json`'s own `include`
before choosing.

### 3 — Wire telescope

Same, on `packages/core`. Confirm `packages/ui`'s coverage and report it.

### 4 — Prove the gate fails, in each repo separately

Append a deliberate type error to one spec per repo (e.g.
`const __probe: number = 'no'`), run that repo's `pnpm typecheck`, confirm it
**fails and names the spec file**. Revert, confirm 0. **Report all four runs.**

This is the step that separates this plan from the thing it fixes. A gate nobody
proved can fail is not a gate — and it is the seventh instance of that pattern in
this audit.

### 5 — Prove coverage, not just success

A passing command proves nothing about what it covered. Use
`tsc -p <config> --listFiles` and report the count of files under `test/` for each
project, before and after. Zero-before, non-zero-after is the evidence.

### Final

Both repos: `pnpm typecheck`, `pnpm lint`, suites vs baselines. durable also
`pnpm build` (plan 012's post-condition must still pass).

Changeset: durable only, and only if you touched anything shippable. A tsconfig/
script change that alters no published artifact needs **no changeset** — say so
explicitly rather than adding an empty one. Telescope likewise.

## Done criteria

ALL must hold:

- [ ] Step 1's measured table reported and reconciled
- [ ] Test dirs are type-checked by a wired script in durable (both packages) and telescope core
- [ ] `packages/ui`'s coverage confirmed either way
- [ ] Step 4 proved the gate fails in BOTH repos (four runs reported)
- [ ] Step 5's `--listFiles` evidence reported per project
- [ ] No `@ts-nocheck`, no `@ts-expect-error`, no new `exclude`, no `skipLibCheck` widening
- [ ] durable's `tsconfig.build.json` still emits no specs into `dist/`
- [ ] plan 012's `.typecheck.tsbuildinfo` / no-build-buildinfo split intact
- [ ] durable `pnpm build`, `pnpm typecheck`, `pnpm lint` exit 0; suite ≥ 984 passed / 19 skipped
- [ ] telescope `pnpm typecheck`, `pnpm lint` exit 0; suite ≥ your measured baseline
- [ ] Telescope work is on a NEW branch, not `master`
- [ ] No files outside the in-scope list modified

## STOP conditions

Stop and report back if:

- Any package's re-measured error count is not 0. Report it; do not invent a
  ratchet here.
- Adding tests to the checked set pulls them into `tsconfig.build.json` and they
  would be emitted into `dist/`. That would ship specs to npm — stop, do not
  "just add an exclude" without reporting.
- durable's build post-condition starts failing.
- telescope's baseline is not green on arrival — report it, do not debug it here.

## Maintenance notes

- **The whole cost of this gap was invisible for as long as it existed**, which is
  the definition of the pattern this audit keeps finding: a verification that looks
  present and is not wired. Eight instances now.
- **The number is the lesson.** 0 here versus 332 in `authkit-server` is not a
  quality difference between the repos — it is japa's context augmentation versus
  vitest's imported `expect`. When you switch on a check that was never on,
  establish that the *harness* is complete before reading the count as debt.
- `adonis-agent` is the remaining sibling; both its packages measured 0 too.

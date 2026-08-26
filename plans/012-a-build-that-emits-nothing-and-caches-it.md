# Plan 012: `pnpm build` can produce an empty `dist/` — and write it to the turbo cache

> Read this plan fully before starting. Honor the STOP conditions. Every number
> and behaviour below was reproduced by the advisor on this worktree at `918c7ae`
> with turbo `2.9.18` and Node 22. Re-run the reproduction yourself first.

## Status

TODO. Opened as a one-line row after plan 011's review, on a premise that turned
out to be **wrong**. The real defect, found while trying to verify that premise,
is worse. Read "The premise that was wrong" so the false lead dies here.

## The defect, reproduced

```
rm -rf packages/adonis/dist packages/adonis/.tsbuildinfo
npx turbo run build --filter=@adonis-agora/durable     # 124 .js files in dist ✅
rm -rf packages/adonis/dist                            # a developer cleans dist
npx turbo run build --filter=@adonis-agora/durable --force
find packages/adonis/dist -name '*.js' | wc -l         # → 0
ls packages/adonis/dist                                # → assets  stubs
```

`tsconfig.base.json` sets `"incremental": true` and
`packages/adonis/tsconfig.json` sets `"tsBuildInfoFile": ".tsbuildinfo"`. Delete
`dist/` and leave the buildinfo, and `tsc` concludes every output is current and
emits **nothing**. The `copy:stubs` half is a plain `cp`, so it still runs — you
get a `dist/` containing `assets/` and `stubs/` and zero JavaScript. A build that
looks like it ran, exit code 0.

**And then it is cached.** The `--force` run above writes that empty `dist/` into
the turbo cache as a successful `build` output. Continue the reproduction:

```
rm -rf packages/adonis/dist packages/adonis/.tsbuildinfo
npx turbo run build --filter=@adonis-agora/durable     # >>> FULL TURBO, 52ms
find packages/adonis/dist -name '*.js' | wc -l         # → 0
```

A clean tree, a cache hit, and the restored artifact has no JavaScript in it. One
`--force` after a manual `rm -rf dist` poisons the cache entry for every
subsequent run on that machine — and for every consumer of a remote cache, if one
is ever turned on.

The advisor poisoned and then repaired the local cache while confirming this
(`--force` with dist and buildinfo both absent restores a correct 124-file
entry). Expect to do the same.

## What is NOT affected, stated precisely

Do not oversell this in the changeset.

- **CI is currently protected, by accident and by plan 011.** `turbo.json`'s
  `test` now declares `dependsOn: ["build", "^build"]`, and
  `packages/adonis/test/configure-export.spec.ts` hard-fails under CI when
  `dist/src/index.js` is missing. So an empty `dist/` in CI fails the suite. CI
  also starts from a cold checkout, so the trigger (a manual `rm -rf dist`)
  does not occur there.
- **`release.yml` runs `pnpm test` in the same job before publishing**, so the
  build the tests forced is the one on disk at publish time.

The exposure is therefore: **a developer machine, and any cache shared from
one.** `packages/adonis/package.json` has `prepack: pnpm run build` and
`files: ["dist/", …]`, so a manual `pnpm publish` from a tree in this state
would ship a package with stubs, assets and no code. That is the worst outcome
and it does not require CI to be broken.

## The premise that was wrong — kill it here

Plan 011's review opened this follow-up claiming that `turbo.json`'s
`typecheck` task declares `outputs: ["*.tsbuildinfo"]` and that this glob **does
not match** the dotfile `.tsbuildinfo`. **That is false on turbo 2.9.18.**
Verified directly: run `typecheck`, delete `.tsbuildinfo`, run `typecheck` again
→ `FULL TURBO`, and the 176202-byte `.tsbuildinfo` is restored from cache. The
glob matches.

So do **not** "fix" that glob. It works. The reason this matters beyond
bookkeeping: acting on that premise would have produced a no-op commit with a
changeset claiming a hazard was closed, while the real one — which the same
investigation found — stayed open.

There *is* a genuine adjacent problem, but it is a different one:

**`build` and `typecheck` write the same buildinfo file.** Both are
`tsc -p tsconfig.json` (one with `--noEmit`), so both resolve
`tsBuildInfoFile: ".tsbuildinfo"`. Two turbo tasks with different `outputs`
declarations racing on one file. TypeScript 5.9.3 does distinguish a `--noEmit`
buildinfo from an emitting one, which is the only reason `typecheck` before
`build` (the order in both workflows) does not currently produce a false green —
but nothing in the repo records that dependency, and it is not self-evident.

## The fix

**Make `build` unable to disagree with `dist/`.** Declaring `.tsbuildinfo` in
`build`'s `outputs` does **not** do this — the advisor tried it, and both the
`--force` path and the cache-hit path still yielded 0 JS files. Test any
candidate against the full reproduction above, not just the first three lines.

Two changes are wanted; decide the exact shape yourself and justify it:

1. **`build` cleans its own incremental state.** The build script should remove
   `dist/` and its buildinfo before `tsc`, so no external deletion can leave the
   two disagreeing. Cost: `tsc` on this package is ~6s cold, and the build was
   never getting an incremental win in CI anyway (cold checkout every time). If
   you would rather set `"incremental": false` for the emitting project, that is
   also defensible — argue for one.
2. **A post-condition the script itself enforces.** After `tsc`, fail loudly if
   `dist/` contains no JavaScript. This is what makes the `prepack` path safe,
   because `prepack` does not go through turbo and never will. A one-line node
   check in the `build` script is enough; make its error message say what
   happened and how to recover.

Also separate the two buildinfo files so `build` and `typecheck` stop sharing
one, and update `turbo.json`'s `typecheck` `outputs` to whatever path you choose.

`packages/eslint-plugin/tsconfig.json` has the same `tsBuildInfoFile`
declaration. Check whether it has the same exposure; it is a much smaller
package, so the answer may be "yes but harmless" — say which.

## Current state

Read before editing:
- `turbo.json` — all four tasks. `build`: `dependsOn: ["^build"]`,
  `outputs: ["dist/**"]`. `test`: `dependsOn: ["build", "^build"]` (plan 011).
  `typecheck`: `outputs: ["*.tsbuildinfo"]`.
- `tsconfig.base.json:19` — `"incremental": true`.
- `packages/adonis/tsconfig.json:6` — `"tsBuildInfoFile": ".tsbuildinfo"`.
- `packages/adonis/tsconfig.type-test.json:6-7` — sets `incremental: false` and
  `tsBuildInfoFile: null`. Someone already needed this escape once; read why.
- `packages/adonis/package.json` — `build`, `copy:stubs`, `prepack`, `files`.
- `packages/eslint-plugin/tsconfig.json` and its `package.json`.
- `packages/adonis/test/configure-export.spec.ts` — plan 011's guard, and the
  reason CI is currently protected. Do not weaken it.
- `.github/workflows/ci.yml` and `release.yml` — the step order.

## Commands you will need

```
cd /home/dudousxd/personal/oss/adonis/adonis-durable-worktrees/advisor-wave-1
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # NOT nvm; mise
pnpm build && pnpm typecheck && pnpm lint
cd packages/adonis && npx vitest run        # NOT turbo — it serves cached greens here
```

**Verified baselines.** Local, with `dist/` present: `970 passed | 19 skipped`.
That is *not* the CI number — CI reports `970 | 19` only since plan 011; before
it, `969 | 20`. If you delete `dist/` you will see the skip come back unless
`CI=1`. Plan 011's review has the detail; do not treat a moving skip count as a
regression without checking which of the two situations you are in.

`pnpm lint` is `biome check .`, not a turbo task — `--force` is not a valid flag
for it.

## Scope

**In scope:**
- `turbo.json`
- `packages/adonis/package.json` — `build` script and any helper script it calls
- `packages/adonis/tsconfig.json` — buildinfo path / `incremental`
- `packages/eslint-plugin/` — the equivalent, if the exposure is real there
- `tsconfig.base.json` — only if the chosen fix requires it, and say why
- `scripts/` — a small helper if the build post-condition wants one
- `packages/adonis/test/` — a guard, if you can write an honest one (see step 4)
- `.changeset/<generated>.md`

**Out of scope:**
- `configure-export.spec.ts`'s behaviour and plan 011's `dependsOn`. Settled.
- Making the build faster. Correctness only.
- The `*.tsbuildinfo` glob. It works. See above.
- Remote caching configuration.

## Git workflow

- Branch `advisor/durable-wave-1`. Do NOT push, merge, rebase, or create branches.
- Commit as you go.

## Steps

### 1 — Reproduce, before changing anything

Run the full reproduction, both halves — the `--force` empty build **and** the
poisoned cache hit that follows. Report the JS file counts at each stage. If you
cannot reproduce it, STOP: something about your turbo version or install state
differs and the rest of this plan does not apply.

Then repair the cache (`--force` with both `dist/` and the buildinfo deleted) and
confirm 124 JS files, so you are not building on a poisoned entry.

### 2 — Fix the build

Implement your chosen shape from "The fix". Then re-run the **entire**
reproduction from step 1 and show that every stage now yields a populated
`dist/` — including the `--force`-after-`rm -rf dist` path, which is the one
that defeats the naive fix.

### 3 — Prove the post-condition fires

Deliberately make `tsc` emit nothing (e.g. temporarily restore the old script and
recreate the stale-buildinfo state) and confirm the post-condition **fails the
build** with a message that explains itself. Then restore. Report both runs.

Without this, step 2's guard is another declaration nobody proved is enforced —
which is the pattern this whole plan set exists to stamp out.

### 4 — Separate the two buildinfo files

Give `build` and `typecheck` distinct `tsBuildInfoFile` paths and align
`turbo.json`. Verify: run `typecheck` then `build` and confirm `dist/` is
populated; run `build` then `typecheck` and confirm `typecheck` still exits 0.

Consider whether a spec can guard any of this cheaply. If the only honest guard
would be a slow full-build test, say so and skip it — step 3's runtime
post-condition is the durable protection, and an integration test that shells out
to `tsc` is exactly the kind of spec that gets `it.skip`ped (durable plan 011 is
that story).

### 5 — `eslint-plugin`

Same check. Report whether the exposure exists and whether you fixed it.

### Final

`pnpm build`, `pnpm typecheck`, `pnpm lint`, then `npx vitest run` in
`packages/adonis` against 970|19. State which `dist/` situation you were in.

Changeset: **patch**. It must state that `pnpm build` could exit 0 having emitted
no JavaScript when `dist/` was removed without its buildinfo, that the result
could be cached and re-served, and that the build now fails loudly instead. Say
plainly that no published version is known to be affected — CI's cold checkouts
and plan 011's `dist/` import spec both stood in the way — so nobody re-publishes
out of fear.

## Done criteria

ALL must hold:

- [ ] Step 1 reproduced both the empty build AND the poisoned cache hit, with counts
- [ ] `--force` after `rm -rf dist` now produces a populated `dist/`
- [ ] The subsequent cache-hit path also produces a populated `dist/`
- [ ] The build fails loudly when `tsc` emits nothing, and step 3 proved it (both runs)
- [ ] `build` and `typecheck` no longer share one buildinfo file
- [ ] `turbo.json`'s `typecheck` `outputs` matches the actual path
- [ ] The `*.tsbuildinfo` glob was NOT "fixed" — the plan's original premise is recorded as false
- [ ] `configure-export.spec.ts` is untouched and still passes
- [ ] `eslint-plugin` assessed, with a stated verdict
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint` exit 0
- [ ] Suite 970 passed / 19 skipped (or the number explained)
- [ ] A patch changeset that does not imply a published version is broken
- [ ] No files outside the in-scope list modified

## STOP conditions

Stop and report back if:

- Step 1 does not reproduce.
- Cleaning `dist/` in the build script breaks `copy:stubs` ordering or the
  `assets/` copy in a way that needs restructuring the script.
- Making the build non-incremental pushes the build past ~30s — report the
  timing and let the maintainer weigh it.
- Separating the buildinfo files makes `pnpm typecheck` slower than the test
  suite, or makes `type-test.json` behave differently.
- You find evidence a **published** version shipped without JavaScript. That
  stops everything and gets reported immediately; it is not a patch changeset.

## Maintenance notes

- **Two lessons, and the second is the expensive one.** First: an incremental
  compiler's state file is an output, and deleting a build's *visible* output
  without it produces a silent no-op. Second: **a poisoned artifact gets cached**.
  Turbo does not validate that a task's declared outputs are non-empty or sane —
  exit 0 means "cache this". Any task whose success can be vacuous needs its own
  post-condition, because the cache will faithfully preserve the vacuum.
- **How this plan came to exist is itself the warning.** It was opened from a
  reviewer's inference about glob semantics that was never tested. The inference
  was wrong, and the code it pointed at was fine. The real bug was two commands
  away. Reproduce before planning; an untested premise costs more than the fix.
- The `type-test.json` opt-out (`incremental: false`, `tsBuildInfoFile: null`)
  suggests someone already hit incremental-state trouble here and solved it
  locally for one config instead of asking why it was needed.

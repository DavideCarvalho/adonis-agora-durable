# Plan 010: Stop `configure-export.spec.ts` from flaking out the release gate

> Read this plan fully before starting. Honor the STOP conditions. Verify every
> excerpt against the live file before acting — if an excerpt does not match,
> treat it as a STOP condition.

## Status

TODO

## Why this matters

`packages/adonis/test/configure-export.spec.ts` (added by plan 002 in wave 2)
builds and dynamically imports the package's dist artifact to assert that
`configure` is re-exported from the main entry. It is a genuinely valuable test
— it is the only thing that catches `node ace add @adonis-agora/durable` being a
no-op — but it runs under vitest's **default 5 s** `testTimeout`, and a build +
ESM import of a real artifact does not reliably fit in 5 s under full-suite load.

Measured on this machine, both directions, by the reviewer:

- run alone: **passes in 800 ms**
- run inside the full suite: **fails on timeout**

So the suite is nondeterministic: `969 passed | 19 skipped | 1 failed` in one
run, green in another, purely as a function of machine load.

This became urgent with plan 007 (commit `b74133e`), which added `pnpm test` as a
gate in `.github/workflows/release.yml` between install and the changesets
publish step. A flaky spec there does not merely annoy — it **blocks
publishes at random**, and the natural human response to a release that failed
for no visible reason is to re-run it until it goes green, which trains everyone
to ignore exactly the gate plan 007 just installed.

## Current state

`packages/adonis/vitest.config.ts` (the whole file, as of commit `60123ab`):

```ts
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.{spec,test}.ts'],
    pool: 'forks',
    globalSetup: ['./test/setup/sqlite-preflight.ts'],
  },
});
```

Note there is **no** `testTimeout` set — hence the 5 s default. (The sibling repo
`adonis-telescope` sets `testTimeout: 20_000` / `hookTimeout: 20_000` at
`packages/core/vitest.config.ts` for the same class of reason, with a comment
explaining why. That is the exemplar to follow for comment style.)

Read `packages/adonis/test/configure-export.spec.ts` in full before editing —
it is short. The failing assertion is around line 19-20:

```ts
      const mod = (await import(distIndexUrl.href)) as Record<string, …
      expect(typeof mod.configure).toBe('function');
```

## Commands you will need

```
cd /home/dudousxd/personal/oss/adonis/adonis-durable-worktrees/advisor-wave-1
export PATH=/home/dudousxd/.local/share/mise/installs/node/22/bin:$PATH   # NOT nvm; this box uses mise
cd packages/adonis
npx vitest run test/configure-export.spec.ts    # isolated
npx vitest run                                  # full suite
```

Node 22 is mandatory. The machine default is Node 26 and `better-sqlite3` is
built for 22; on 26 the sqlite preflight aborts the suite by design (that is
plan 009 working, not a failure).

**Do not verify through `turbo`.** Call `vitest` directly, or pass `--force`.
Turbo does not track the native binary or the dist artifact as inputs and will
serve a cached green result — this has already produced a false green twice in
this repo family.

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/test/configure-export.spec.ts` (preferred fix — see Step 2)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/vitest.config.ts`. Raising the **global** timeout would mask
  genuine hangs in the other ~170 spec files. Only this one spec is slow, and
  only because it builds. Scope the timeout to the spec, not the suite. If you
  conclude the global config is genuinely the only workable place, that is a
  STOP condition — report it, do not just do it.
- `.github/workflows/release.yml`. Plan 007 is correct as landed; this plan
  makes its gate trustworthy, it does not change it.
- The build step the spec shells out to, and anything under `src/`.
- Making the spec faster by not building. The build is the point of the test.

## Git workflow

- Branch: stay on `advisor/durable-wave-1` (already checked out in the worktree
  above). Do NOT create a new branch, do NOT push, do NOT merge.
- One commit. Conventional commits, e.g.
  `test(durable): give the dist-import spec a timeout that fits a real build`.
- No changeset — this changes no shipped code. (`.changeset/` untouched.)

## Steps

### Step 1 — Reproduce both directions

Before changing anything, confirm the flake is real on your machine:

1. `npx vitest run test/configure-export.spec.ts` → expect pass, note the duration.
2. `npx vitest run` (full suite) → note whether this spec fails, and the reported
   `Test Files` / `Tests` line.

If the full-suite run passes, run it once more under load. If it still passes
twice, **STOP and report** — the flake may be machine-specific and the fix
should not be applied blind.

### Step 2 — Scope a timeout to the spec

Give this one test an explicit timeout generous enough for a cold build. vitest
takes a per-test timeout as the third argument:

```ts
it('the built package main exports configure as a function', async () => {
  …
}, 60_000);
```

(or the equivalent for whatever `describe`/`it` shape the file actually uses —
read it first). If the file has a `beforeAll` that performs the build, the
`hookTimeout` equivalent applies there instead: pass the timeout to the hook.
**Put the timeout where the slow work actually happens** — if the build is in a
hook and you only raise the test's timeout, you have fixed nothing.

Add a one-line comment saying why, in the style of telescope's:

```ts
// This spec runs a real package build and ESM-imports the dist artifact; the
// default 5s timeout does not fit that under full-suite load.
```

60 s is a deliberate ceiling, not a target: it must be long enough that load
never causes a false failure, and short enough that a genuinely hung build still
fails the run rather than sitting forever.

### Step 3 — Prove the fix under load

Run the **full suite** (`npx vitest run`, not turbo) at least **three times**.
All three must report `0 failed`. Record all three `Tests` lines in your report.

One green run is not evidence here — the bug is nondeterministic, and a single
pass is exactly what it looks like when nothing was fixed.

### Step 4 — Confirm scope

`git status --porcelain` must show exactly one modified file.

## Done criteria

ALL must hold:

- [ ] The timeout is scoped to this spec (or its build hook), NOT to `vitest.config.ts`
- [ ] The timeout is attached to whichever unit actually performs the build
- [ ] A comment explains why the default is insufficient
- [ ] Step 1 reproduced the failure in the full suite (report the run)
- [ ] Three consecutive full-suite runs report `0 failed` (report all three)
- [ ] Verification was done via `vitest` directly, not via cached `turbo`
- [ ] `git status --porcelain` shows exactly one modified file
- [ ] No changeset was added

## STOP conditions

Stop and report back (do not improvise) if:

- The full suite passes twice in Step 1 — you cannot verify a fix for a failure
  you cannot reproduce.
- The spec turns out to fail for a reason other than timeout (e.g. the dist
  artifact is genuinely missing, or the build errors). That is a different bug
  and a bigger one; report it rather than papering over it with a timeout.
- The slow work is not where you expected and scoping the timeout would require
  restructuring the spec.
- You conclude the global `vitest.config.ts` timeout is the only workable place.
  Report the reasoning; do not apply it unilaterally.

## Test plan

No new tests. This plan makes an existing test deterministic. The verification
*is* the three-run repetition in Step 3.

## Maintenance notes

- Any future spec that builds or imports a real artifact needs the same
  treatment. This repo now has one such spec; telescope solved the same class of
  problem at the config level because *its* slow specs are the whole Lucid store
  suite, not one file. Different shapes, different scopes — do not copy
  telescope's global setting here.
- `pnpm test` is now a release gate (plan 007). Treat any flaky spec in this
  repo as release-blocking from here on, not as background noise.

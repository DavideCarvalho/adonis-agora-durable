# Plan 001: Make `pnpm test` runnable again on a developer machine

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- package.json .nvmrc .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none — this plan unblocks every other plan in this directory
- **Category**: dx
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

Two independent environment problems make it impossible to verify any change in
this repo locally today. First, `package.json` pins `pnpm@11.13.0`, a release
whose standalone `@pnpm/exe` build shipped without a binary — every `pnpm`
command in this repo aborts before doing any work. Second, the repo's `.nvmrc`
says Node 20 and CI uses Node 22, but the prebuilt `better-sqlite3` native
binding in `node_modules` only matches one ABI, so on a newer Node the Lucid
store test suites fail with a misleading error. Until both are fixed, an
executor working on plans 002–007 cannot run the tests that prove their change
is correct.

Note what is **not** wrong: CI is green. `pnpm/action-setup@v6` installs the
`pnpm` npm package (19 MB, fine), not `@pnpm/exe` (16 KB, broken), so the pin
only breaks local development. Do not "fix" CI.

## Current state

- `package.json:12` — the broken pin:

  ```json
  "packageManager": "pnpm@11.13.0",
  ```

  Reproduce the failure with any pnpm command in this directory:

  ```
  [ERROR] pnpm v11.13.0 is a broken release and cannot be installed
  Its "@pnpm/exe" build shipped without a binary and does not run.
  ```

- `package.json:37-44` — a dead `pnpm` config block that pnpm 11 no longer
  reads. It prints a warning on every command and duplicates settings that now
  live in `pnpm-workspace.yaml:22-27`:

  ```
  [WARN] The "pnpm" field in package.json is no longer read by pnpm.
  The following keys were ignored: "pnpm.onlyBuiltDependencies".
  ```

- `.nvmrc` contains `20`, while `.github/workflows/ci.yml:23` sets
  `node-version: 22`. `packages/adonis/package.json` declares
  `"engines": { "node": ">=20.6.0" }` — an open-ended range that admits Node
  versions the prebuilt native dependency cannot serve.

- The native-module symptom, for recognition (this is NOT a code bug):

  ```
  The module '.../better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using
  NODE_MODULE_VERSION 127. This version of Node.js requires
  NODE_MODULE_VERSION 147.
  ```

- Repo conventions that apply here: changes are released through changesets
  (`.changeset/`); commit messages are conventional commits — see
  `git log --oneline -5` for examples such as
  `fix(dashboard): authorize hook can own its denial response (#41)`.
  A tooling-only change like this one takes a `chore:` prefix and needs **no**
  changeset (it does not affect published behaviour).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| pnpm sanity | `pnpm --version` | prints a version, no `[ERROR]` line |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Node version | `node -v` | matches `.nvmrc` |

## Scope

**In scope** (the only files you should modify):
- `package.json` (the `packageManager` field and the dead `pnpm` block)
- `.nvmrc`
- `packages/adonis/package.json` (the `engines` field only)

**Out of scope** (do NOT touch, even though they look related):
- `.github/workflows/ci.yml` — CI is green; the pin does not affect it, and
  changing the workflow to "fix" a problem it does not have adds risk for
  no benefit.
- `pnpm-workspace.yaml` — its `allowBuilds` / `onlyBuiltDependencies` /
  `ignoredBuiltDependencies` / `strictDepBuilds` block is contradictory and
  contains a literal placeholder string, but it exists because
  `ERR_PNPM_IGNORED_BUILDS` once killed a release. Untangling it is a
  separate, riskier change; leave it alone here.
- `pnpm-lock.yaml` — should only change as a side effect of `pnpm install`,
  never by hand.

## Git workflow

- Branch: `chore/restore-local-verification-baseline`
- One commit; message style: conventional commits, e.g.
  `chore: unpin broken pnpm 11.13.0 and align Node to CI`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Unpin the broken pnpm release

In `package.json`, change the `packageManager` field from `pnpm@11.13.0` to a
known-good release. Determine the current good version yourself rather than
hardcoding one from this plan:

```bash
npm view pnpm version
```

Then confirm the matching standalone build is not the broken 16 KB stub before
you pin it:

```bash
npm view @pnpm/exe@<version> dist.unpackedSize
```

A healthy release reports roughly 17,000,000 bytes. If it reports something on
the order of 16,000, that version is broken too — pick another and re-check.

**Verify**: `pnpm --version` → prints the version you pinned, with no
`[ERROR] pnpm v… is a broken release` line.

### Step 2: Delete the dead `pnpm` field from `package.json`

Remove the `"pnpm": { ... }` block at `package.json:37-44` entirely. Its
contents are already present in `pnpm-workspace.yaml:22-27`, which is the file
pnpm 11 actually reads. Do not move or edit anything in `pnpm-workspace.yaml`.

**Verify**: `pnpm install --frozen-lockfile` → exit 0, and the output no longer
contains `The "pnpm" field in package.json is no longer read by pnpm`.

### Step 3: Align `.nvmrc` with CI

Set `.nvmrc` to `22`, matching `node-version: 22` in
`.github/workflows/ci.yml:23`. Local and CI currently disagree, and CI is the
one that is known-good.

**Verify**: `cat .nvmrc` → `22`

### Step 4: Bound the Node range in `packages/adonis/package.json`

Change `engines.node` from `">=20.6.0"` to a bounded range that cannot admit a
Node whose ABI the prebuilt native test dependency does not serve:

```json
"engines": { "node": ">=20.6.0 <23" }
```

This is a devtime guard, not a runtime restriction on library consumers —
`better-sqlite3` is a devDependency used only by the test harness. If you find
`better-sqlite3` is a runtime dependency rather than a devDependency, that
contradicts this plan's assumption: STOP and report.

**Verify**: `node -p "require('./packages/adonis/package.json').engines"` →
`{ node: '>=20.6.0 <23' }`

### Step 5: Rebuild the native binding and confirm the suite runs

With Node on the version from `.nvmrc` (use `nvm use` if available), rebuild
the native module so its ABI matches the running Node:

```bash
pnpm rebuild better-sqlite3
```

**Verify**: `pnpm test` → exit 0. If tests fail, check the failures against the
STOP conditions below before attempting any fix.

## Test plan

No new tests. This plan restores the ability to run the existing suite; the
suite itself is the verification.

Record the pass/fail counts you observe in your report so the next executor has
a known baseline to compare against. At the time this plan was written, running
vitest directly on a mismatched Node produced 8 failed files / 77 failed tests,
essentially all from the native-module error, plus one independent failure in
`packages/adonis/test/engine/transports/bullmq/deps.spec.ts` that times out
after 5s because it constructs a live ioredis client against `127.0.0.1:6379`.
That BullMQ failure is a **known, separate issue** and is not in scope here — if
it is the only remaining failure after this plan, that is the expected outcome.

## Done criteria

ALL must hold:

- [ ] `pnpm --version` prints a version with no `[ERROR]` line
- [ ] `pnpm install --frozen-lockfile` exits 0 with no `"pnpm" field ... ignored` warning
- [ ] `grep -n '"pnpm"' package.json` returns no match for the config block
- [ ] `cat .nvmrc` prints `22`
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, OR the only failure is
      `test/engine/transports/bullmq/deps.spec.ts` (documented above as
      out of scope)
- [ ] No files outside the in-scope list are modified, except `pnpm-lock.yaml`
      if `pnpm install` legitimately updated it (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `package.json:12` does not read `"packageManager": "pnpm@11.13.0"` — someone
  already fixed this and the rest of the plan may not apply.
- After Step 5, tests fail with errors that are **not** the
  `NODE_MODULE_VERSION` / `Module did not self-register` native-binding message
  and not the known `deps.spec.ts` timeout. That would mean a real code
  regression exists, which is outside this plan.
- `pnpm install --frozen-lockfile` fails with `ERR_PNPM_IGNORED_BUILDS`. That
  is the exact failure the `pnpm-workspace.yaml` build config was written to
  prevent, and it means the out-of-scope file now needs attention — report
  rather than editing it.
- `better-sqlite3` turns out to be a runtime dependency rather than a
  devDependency (see Step 4).

## Maintenance notes

- The `pnpm-workspace.yaml` build-config tangle (four overlapping mechanisms
  governing `msgpackr-extract`, including a literal
  `msgpackr-extract: set this to true or false` placeholder at line 13) was
  deliberately left alone. It should be reduced to one mechanism, but only
  after this plan lands and only with a verified clean `--frozen-lockfile`
  install, because that config exists to prevent a release-breaking
  `ERR_PNPM_IGNORED_BUILDS`.
- A reviewer should confirm `.github/workflows/ci.yml` was **not** modified.
- The real long-term fix for the native-binding fragility is replacing
  `better-sqlite3` in the test harness with Node's built-in `node:sqlite`
  (available from Node 22.5), which removes this class of failure entirely.
  Deliberately deferred — it touches every store test's setup.

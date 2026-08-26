# Plan 009: Fail fast with an actionable message when the sqlite driver can't load

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/vitest.config.ts packages/adonis/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md` (DONE)
- **Category**: dx
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

`better-sqlite3` ships a prebuilt binary tied to a specific Node ABI
(`NODE_MODULE_VERSION`). When the running Node does not match, the import throws
deep inside the native loader with a message that says nothing about Node
versions — and because every Lucid-store spec then fails in its own teardown, the
developer sees a wall of unrelated errors instead of the one real cause. On this
project that cost a full debugging session: 271 failures in `adonis-authkit`, ~77
here, all from one ABI mismatch.

Plan 001 reduced the chance of hitting it (`.nvmrc` pinned to 22, `engines`
bounded to `<23`). This plan makes it *diagnosable in seconds* when it happens
anyway — a developer on a different Node, a stale `node_modules`, a CI image
bump.

Be clear about what this is: **a mitigation, not a fix.** The native-binding
fragility remains. Two routes to eliminating it were investigated and rejected —
see Maintenance notes, so nobody re-investigates them.

`adonis-authkit` already has this and it works; this plan ports it, adapted to a
different test runner.

## Current state

- `packages/adonis/vitest.config.ts` — no setup or preflight of any kind:

  ```ts
  import swc from 'unplugin-swc';
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    plugins: [swc.vite({ module: { type: 'es6' } })],
    test: {
      environment: 'node',
      globals: true,
      include: ['test/**/*.{spec,test}.ts'],
      pool: 'forks',
    },
  });
  ```

- `better-sqlite3` is declared at `packages/adonis/package.json:166` as
  `"better-sqlite3": "^11.0.0"`, a **devDependency** used only by the test
  harness. Confirm that before you start.

- **The exemplar to port**, from `adonis-authkit`'s
  `packages/authkit-server/bin/test.ts`. That repo uses **japa**, so the
  preflight is a plain `await` before `run()`. Note the message content — that is
  the part worth copying verbatim:

  ```ts
  async function assertSqliteDriverLoads(): Promise<void> {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(':memory:');
      db.prepare('select 1').get();
      db.close();
    } catch (error) {
      console.error(
        [
          '',
          'sqlite driver failed to load — this usually means `better-sqlite3` was',
          'built for a different Node ABI. Run `nvm use` (see `.nvmrc`) then',
          '`pnpm rebuild better-sqlite3`.',
          '',
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
          '',
        ].join('\n'),
      );
      process.exit(1);
    }
  }

  await assertSqliteDriverLoads();
  ```

- **This repo is vitest, not japa** — so there is no `bin/test.ts` to hook. The
  equivalent is vitest's `globalSetup`, which runs once in the main process
  before any test file and can abort the run by throwing. Do not try to
  replicate the japa shape.

- Repo conventions: conventional commits; vitest; changesets for user-visible
  changes. A test-tooling change needs **no** changeset.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm test` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/vitest.config.ts` (register the global setup)
- `packages/adonis/test/setup/sqlite-preflight.ts` (create — adjust the path if
  the repo has an existing convention for non-spec test helpers)

**Out of scope** (do NOT touch, even though they look related):
- `.nvmrc`, `engines`, `packageManager` — plan 001 already handled all three.
- Any spec file. This plan changes when and how the suite *fails*, never what it
  asserts.
- `packages/eslint-plugin/` — it has no sqlite dependency.
- Replacing `better-sqlite3` with another driver. Investigated and rejected; see
  Maintenance notes.

## Git workflow

- Branch: continue on `advisor/durable-wave-1` if it exists, else
  `chore/sqlite-preflight`
- One commit; message style: conventional commits, e.g.
  `chore(test): fail fast with an actionable message when sqlite can't load`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the preflight module

Create `packages/adonis/test/setup/sqlite-preflight.ts` exporting a vitest
`globalSetup` function. It must:

1. Dynamically import `better-sqlite3`, open `:memory:`, run `select 1`, close.
2. On success, return silently.
3. On failure, **throw** an `Error` whose message carries the same actionable
   guidance as the authkit exemplar above — name the likely cause (a Node ABI
   mismatch), the two commands that fix it (`nvm use`, then
   `pnpm rebuild better-sqlite3`), and include the underlying error text.

Throw rather than `process.exit(1)`: in `globalSetup` vitest surfaces a thrown
error as a clean run-level failure, whereas an abrupt exit can truncate reporter
output. This is the one deliberate deviation from the japa exemplar.

Give the module a doc comment explaining why it exists, modelled on the
exemplar's — the next reader must understand it is a diagnostic, not a test.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Register it

Add `globalSetup` to `packages/adonis/vitest.config.ts`'s `test` block, pointing
at the new file. Leave every existing option (`environment`, `globals`,
`include`, `pool`) untouched.

**Verify**: `pnpm test` → exit 0, same pass counts as before your change
(`958 passed | 19 skipped` at the time of writing — record what you actually
observe, before and after).

### Step 3: Prove it fires — this is the whole point

A preflight that never triggers is worthless. Simulate the failure and confirm
the message appears.

Temporarily rename the native binding so the import fails:

```bash
find node_modules/.pnpm -name 'better_sqlite3.node' -path '*better-sqlite3*'
```

Move the file aside, run `pnpm test`, and confirm:

- the run aborts with **your** message naming the ABI mismatch and the two fix
  commands, and
- it does **not** produce a wall of unrelated per-spec failures.

Then restore the binary and confirm `pnpm test` is green again.

Report both observations verbatim — the before/after contrast is the evidence
this plan exists to produce.

**Verify**: with the binding moved, the run fails with your message; restored,
`pnpm test` → exit 0.

### Step 4: Confirm you changed nothing else

```bash
git status --porcelain
```

**Verify**: only the two in-scope files appear.

## Test plan

No new specs — this is test tooling. The verification is Step 3's simulated
failure, which must be performed and reported.

Do **not** add a spec that asserts the preflight works by breaking the driver:
it would have to mutate `node_modules` mid-run and would be flaky and hostile to
parallel runs.

## Done criteria

ALL must hold:

- [ ] `packages/adonis/test/setup/sqlite-preflight.ts` exists and exports a `globalSetup` function
- [ ] It throws (not `process.exit`) on failure
- [ ] Its message names the ABI mismatch, `nvm use`, and `pnpm rebuild better-sqlite3`, and includes the underlying error
- [ ] `packages/adonis/vitest.config.ts` registers it via `globalSetup`, with every pre-existing option unchanged
- [ ] Step 3 was performed: with the binding moved the run fails with the new message and no error wall; restored, the suite is green
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 with the same pass counts as before the change
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `vitest.config.ts` already registers a `globalSetup` — merge into it rather
  than replacing it, and report that you did.
- The preflight fires on a healthy environment (a false positive). A preflight
  that blocks a working suite is worse than none — report rather than loosening
  it until it passes.
- `better-sqlite3` turns out not to be a devDependency.
- Moving the native binding in Step 3 does **not** make the suite fail. That
  would mean the store specs are not exercising the driver you think they are,
  which is worth knowing before shipping a preflight for it.

## Maintenance notes

- **Two routes to eliminating the fragility were investigated and rejected.**
  Recorded here so nobody re-investigates:
  - **`node:sqlite`** (Node's built-in, 22.5+): Lucid reaches the database
    through Knex, and Knex 3.3.0 ships no `node:sqlite` dialect. No community
    dialect exists either (checked `knex-node-sqlite`, `knex-nodesqlite`,
    `@knex/node-sqlite`, `knex-dialect-node-sqlite` — none published). Adopting
    it means authoring and maintaining a Knex dialect on the critical path of
    four libraries' store tests.
  - **`libsql`** (Lucid ships a first-class `libsql` client): does not help.
    Lucid's client requires `@libsql/sqlite3`, whose `Database` constructor
    delegates to the classic `sqlite3` native package for any `file:` URL — i.e.
    every local database, which is exactly the test-harness case — via an
    *undeclared* dependency. Its own hrana path is only for **remote**
    libsql/Turso URLs. So it would swap one V8-ABI-bound native module for
    another, worse-maintained one. Verified with a running spike, not inferred.
- The realistic long-term option, if this ever becomes painful enough, is a CI
  matrix across Node majors so an ABI break surfaces in CI rather than on a
  developer's machine.
- `adonis-telescope` has the same gap and its own copy of this plan.
  `adonis-authkit` already has the japa version; `adonis-agent` got a null-safe
  teardown for the same symptom and would still benefit from this preflight.

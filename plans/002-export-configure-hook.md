# Plan 002: Make `node ace add @adonis-agora/durable` actually configure the package

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/src/index.ts packages/adonis/configure.ts packages/adonis/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md` (you cannot run the verification commands until 001 lands)
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

The documented install path for this package is `node ace add
@adonis-agora/durable`. It does nothing. AdonisJS resolves the configure hook by
importing the package's **main entry** and reading `configure` off the module
namespace; this package defines `configure` in `configure.ts` and exposes it
only through the `./configure` subpath, which nothing reads. The result is a
*warning*, not an error — so it looks like it worked:

> `Cannot configure module "@adonis-agora/durable". The module does not export the configure hook`

Every new user hits this. No provider is registered in `adonisrc.ts`, no
`config/durable.ts` is published, no migration stubs are copied — and roughly a
dozen documentation pages instruct users to take exactly this path. Sibling
packages in the same family already do it correctly, so this is a one-line
omission with an outsized cost.

## Current state

- `packages/adonis/configure.ts:20` — the hook exists and is the only export:

  ```ts
  export async function configure(command: Configure) {
  ```

- `packages/adonis/package.json` — it is reachable only via a subpath nobody
  reads:

  ```json
  "./configure": {
    "types": "./dist/configure.d.ts",
    "import": "./dist/configure.js",
    "default": "./dist/configure.js"
  }
  ```

- `packages/adonis/src/index.ts` — the package main. It ends with the
  store-less cluster re-exports and contains **no** `configure` export:

  ```ts
  // --- store-less cluster: handshake & capability negotiation -----------------
  export * from './handshake/descriptor.js';
  export * from './handshake/negotiate.js';
  export * from './handshake/routing.js';
  export * from './dispatch-routing.js';
  ```

- Why the main entry is what matters —
  `node_modules/.pnpm/@adonisjs+core@7.3.4_*/node_modules/@adonisjs/core/build/commands/configure.js`:

  ```js
  55:  return await this.app.import(packageName);      // imports the package MAIN
  119: if (!packageExports.configure) {
  120:   this.logger.warning(`Cannot configure module "${this.name}". The module does not export the configure hook`);
  131: await packageExports.configure(this);
  ```

- **The exemplar to copy.** `@adonis-agora/telescope` has an identical build
  layout (`rootDir: "."`, `outDir: "dist"`, so `src/index.ts` →
  `dist/src/index.js` and `configure.ts` → `dist/configure.js`) and works. The
  last line of `../../adonis-telescope/packages/core/src/index.ts`:

  ```ts
  // Re-export the configure hook from the package root so `node ace configure` finds it
  export { configure } from '../configure.js';
  ```

  Because the emitted layout is the same here, the relative specifier
  `'../configure.js'` is correct for this package too. Verify this in Step 2
  rather than trusting it.

- Repo conventions: conventional commits (see `git log --oneline -5`, e.g.
  `fix: late results never resurrect terminal runs (#39)`), and every
  user-visible change gets a changeset in `.changeset/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `pnpm --filter @adonis-agora/durable build` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Changeset | `pnpm changeset` | creates a file in `.changeset/` |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/src/index.ts` (add the re-export)
- `packages/adonis/test/configure-export.spec.ts` (create)
- `.changeset/<generated>.md` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/configure.ts` — the hook itself is correct; only its
  reachability is broken.
- `packages/adonis/package.json` — the `./configure` subpath stays. Some users
  may import it directly, and removing it would be a breaking change for zero
  benefit.
- The documentation pages under `docs/` that describe `node ace add`. They are
  correct *once this fix lands* — they describe the intended behaviour. Do not
  rewrite them to document the bug.
- `packages/adonis/stubs/main.ts` — do not add a `stubsRoot` export unless
  Step 3 proves it is needed. Telescope works without one.

## Git workflow

- Branch: `fix/export-configure-hook`
- One commit; message style: conventional commits, e.g.
  `fix: export the configure hook from the package main so node ace add works`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the re-export to the package main

Append to the end of `packages/adonis/src/index.ts`:

```ts
// Re-export the configure hook from the package root so `node ace configure` finds it.
// AdonisJS imports the package MAIN and reads `configure` off the module namespace —
// the `./configure` subpath alone is never consulted.
export { configure } from '../configure.js';
```

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Prove the built artifact actually exports it

The whole bug is that the source and the *built* artifact disagreed about
reachability, so verifying against `src/` is not enough. Build, then import the
built main entry the same way AdonisJS does:

```bash
pnpm --filter @adonis-agora/durable build
node -e "import('./packages/adonis/dist/src/index.js').then(m => { if (typeof m.configure !== 'function') { console.error('FAIL: configure is', typeof m.configure); process.exit(1) } console.log('OK: configure is a function') })"
```

**Verify**: prints `OK: configure is a function` and exits 0.

If it fails with a module-resolution error on `../configure.js`, the emitted
layout differs from what this plan assumed — inspect `packages/adonis/dist/`
and adjust the relative specifier so it points at the emitted
`dist/configure.js`. If the layout is not
`dist/src/index.js` + `dist/configure.js`, STOP and report.

### Step 3: Check whether `stubsRoot` is also required

Read `packages/adonis/configure.ts` and determine whether it publishes stubs via
a `stubsRoot` it imports itself (self-contained — nothing more to do) or whether
it expects the caller to provide one. Telescope exports only `configure` and
works, which is strong evidence nothing more is needed here.

Only if `configure.ts` proves to need it, also export `stubsRoot` from the main
entry, mirroring how `@adonis-agora/authkit-server` does it in its `index.ts`:

```ts
export { stubsRoot } from './stubs/main.js';
```

**Verify**: `pnpm typecheck` → exit 0. If you added the `stubsRoot` export,
re-run the Step 2 command and additionally assert `m.stubsRoot` is defined.

### Step 4: Add a regression test against the built artifact

Create `packages/adonis/test/configure-export.spec.ts`. It must assert against
the **built** output, because a test that imports `src/` would have passed even
while the bug shipped. Model the file structure on any existing spec in
`packages/adonis/test/` (they use vitest: `import { expect, it } from 'vitest'`).

The test should:
1. Resolve `dist/src/index.js` relative to the test file.
2. Skip with a clear message if `dist/` does not exist (so a fresh checkout
   without a build does not fail confusingly) — but **fail**, not skip, when
   `dist/` exists and the export is missing.
3. Dynamically import it and assert `typeof mod.configure === 'function'`.

**Verify**: `pnpm test` → exit 0, and the new spec is listed as passing. Then
prove the test actually detects the bug: temporarily comment out the export you
added in Step 1, rebuild, re-run the spec, and confirm it **fails**. Restore the
export and rebuild before continuing. A test that passes both with and without
the fix is worthless — do not skip this mutation check.

### Step 5: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **patch** bump, and describe it as a
fix: `node ace add @adonis-agora/durable` now registers the provider and
publishes config/migration stubs, instead of warning and doing nothing.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- New file: `packages/adonis/test/configure-export.spec.ts`.
  - Case 1 (the regression): the built `dist/src/index.js` exports `configure`
    as a function.
  - Case 2 (only if Step 3 required it): the built main also exports
    `stubsRoot`.
- Mutation check (Step 4): with the re-export removed, the new spec must fail.
- Verification: `pnpm test` → all pass, including the new spec.

## Done criteria

ALL must hold:

- [ ] `grep -n "export { configure }" packages/adonis/src/index.ts` returns a match
- [ ] `pnpm --filter @adonis-agora/durable build` exits 0
- [ ] The Step 2 node one-liner prints `OK: configure is a function`
- [ ] `packages/adonis/test/configure-export.spec.ts` exists and passes
- [ ] The mutation check in Step 4 was performed and the test failed without the fix
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (or only the known `deps.spec.ts` failure documented in plan 001 remains)
- [ ] A changeset file exists in `.changeset/`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `packages/adonis/src/index.ts` already contains a `configure` export — the bug
  is already fixed and this plan is stale.
- The built layout is not `dist/src/index.js` + `dist/configure.js` (Step 2).
- Adding the re-export pulls `@adonisjs/assembler` into the main entry's runtime
  import graph. `configure.ts` imports assembler types; if the built
  `dist/src/index.js` now fails to load in an app that has not installed
  assembler (it is an *optional* peer), that is a real regression — report it
  rather than working around it. Test by importing the built main with
  assembler absent from the resolution path.
- `pnpm typecheck` reports errors in files you did not touch.

## Maintenance notes

- `@adonis-agora/agent` has the **identical** bug and its own plan
  (`plans/002-export-configure-hook.md` in the `adonis-agent` repo). The two
  fixes are independent; neither blocks the other.
- The deeper lesson is that nothing in this repo verifies the *published*
  artifact — `pnpm test` exercises `src/`, so any packaging bug ships silently.
  `@adonis-agora/authkit-server` solves this with
  `scripts/import-smoke.mjs`, which dynamically imports every built `.js` and is
  wired into its CI. Porting that smoke test to this repo would have caught this
  bug and would catch the next one; it is deliberately out of scope here but is
  the highest-value follow-up.
- A reviewer should check that the new test asserts against `dist/`, not `src/`.

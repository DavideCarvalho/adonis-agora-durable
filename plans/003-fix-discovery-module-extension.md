# Plan 003: Make workflow/step directory discovery find `.ts` files in a dev app

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/src/step-discovery.ts packages/adonis/src/workflow-discovery.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

Both directory scanners decide which file extension to import by inspecting
**this library's own compiled file**, not the directory being scanned. In a
consuming AdonisJS app, the library is resolved from `node_modules` as compiled
`.js`, so the scanners look for `.js` files — while the app's `app/workflows`
and `app/steps` contain `.ts`. Every entry is skipped, `readdir` succeeds, and
the functions return an empty array with no warning.

The developer sees `workflow X is not registered` at dispatch time, or steps
that hang forever with no handler, and nothing points at discovery. This is the
same bug class already fixed in `@adonis-agora/agent`'s tool discovery; the
durable twin was deferred and is still live in both files.

## Current state

- `packages/adonis/src/step-discovery.ts:97-98` — the faulty derivation:

  ```ts
  /** Same module-extension gate the workflow scanner uses (`.ts` from source, `.js` from `dist`). */
  const MODULE_EXT = extname(import.meta.url || '') === '.ts' ? '.ts' : '.js';
  ```

  and its use inside `registerStepsFromDir`, at `step-discovery.ts:119`:

  ```ts
  for (const entry of entries.sort()) {
    if (extname(entry) !== MODULE_EXT || entry.endsWith(`.d${MODULE_EXT}`)) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
  ```

- `packages/adonis/src/workflow-discovery.ts:56` — the identical constant, with
  a doc comment (lines 52–55) stating the intent that the code does not achieve:

  ```ts
   * each module path is visited once, so a built `.js` and a dev `.ts` of the same module never both
   * register. Missing directory → empty list (the convention is opt-in: no `app/workflows`, nothing to
  const MODULE_EXT = extname(import.meta.url || '') === '.ts' ? '.ts' : '.js';
  ```

  and its use inside `discoverWorkflows`, at `workflow-discovery.ts:80`:

  ```ts
  for (const entry of entries.sort()) {
    if (extname(entry) !== MODULE_EXT || entry.endsWith(`.d${MODULE_EXT}`)) continue;
  ```

- **The intent to preserve.** The extension gate is not pointless: it exists so
  that a directory containing both a built `foo.js` and its source `foo.ts` does
  not register the same workflow twice. Your fix must keep that property. The
  bug is only *where the extension comes from* — it must be derived from the
  scanned directory's contents, not from `import.meta.url`.

- The affected call sites (the no-barrel fallback path, which is the dev
  default) — `packages/adonis/providers/durable_provider.ts:338-339`:

  ```ts
  const dir = this.app.makePath(config.workflowsPath ?? 'app/workflows');
  await registerWorkflowsFromDir(engine, dir);
  ```

  and `providers/durable_provider.ts:384-385`:

  ```ts
  const dir = this.app.makePath(config.stepsPath ?? 'app/steps');
  await registerStepsFromDir(server as StepServer, dir);
  ```

- There is currently **no** test file covering either scanner
  (`ls packages/adonis/test/ | grep -i discov` returns nothing).

- Repo conventions: conventional commits; vitest (`import { expect, it } from
  'vitest'`); every user-visible change gets a changeset in `.changeset/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Targeted tests | `pnpm --filter @adonis-agora/durable test -- discovery` | new specs pass |
| Lint | `pnpm lint` | exit 0 |
| Changeset | `pnpm changeset` | creates a file in `.changeset/` |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/src/step-discovery.ts`
- `packages/adonis/src/workflow-discovery.ts`
- `packages/adonis/test/step-discovery.spec.ts` (create)
- `packages/adonis/test/workflow-discovery.spec.ts` (create)
- test fixture directories under `packages/adonis/test/fixtures/` (create)
- `.changeset/<generated>.md` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/providers/durable_provider.ts` — the call sites are correct;
  only the scanners are broken.
- The barrel path (`registerWorkflowsFromBarrel` / `registerStepsFromBarrel`
  and `.adonisjs/durable/*.js`). It is the production default and works; this
  bug only affects the fallback scan.
- `@adonis-agora/agent`'s tool discovery — a different repo entirely.

## Git workflow

- Branch: `fix/discovery-module-extension`
- One commit; message style: conventional commits, e.g.
  `fix: derive the discovery module extension from the scanned dir, not the lib`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the module-level constant with a per-directory probe

In **both** `step-discovery.ts` and `workflow-discovery.ts`, delete the
module-level `MODULE_EXT` constant and compute the extension inside the scanning
function from the `readdir` entries already in hand.

The required behaviour, in order:

1. From the entry list, ignore any entry ending in `.d.ts` (declaration files
   are never importable modules).
2. If **any** remaining entry ends in `.ts`, the extension for this scan is
   `.ts`.
3. Otherwise, if any entry ends in `.js`, the extension is `.js`.
4. If neither is present, return the empty result as before.

This preserves the original "never register a built `.js` and a dev `.ts` of the
same module twice" intent — a directory with both resolves to `.ts` only — while
making the choice depend on the directory being scanned rather than on this
library's own file.

Keep the existing `.d.<ext>` exclusion in the loop.

Extract the probe into a small shared helper rather than writing it twice. Put
it in whichever of the two files is the more natural home and import it from the
other, or in a new tiny module if neither fits — but do not duplicate the logic,
because the two copies drifting is exactly how this bug survived.

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Create test fixtures

Under `packages/adonis/test/fixtures/`, create directories that let the specs
exercise each branch. You need, at minimum:

- a directory containing only `.ts` module files exporting a workflow class /
  step handler,
- a directory containing only `.js` module files,
- a directory containing **both** `foo.ts` and `foo.js` defining the same
  workflow/step name, to prove the de-duplication intent still holds,
- a directory containing a `.d.ts` file alongside a real module, to prove
  declaration files are ignored.

Look at how existing specs in `packages/adonis/test/` construct workflow
classes and step handlers and mirror those shapes so the fixtures are
importable.

**Verify**: `ls packages/adonis/test/fixtures/` → the directories you created exist.

### Step 3: Write the regression specs

Create `packages/adonis/test/workflow-discovery.spec.ts` and
`packages/adonis/test/step-discovery.spec.ts`.

Required cases per file:

1. **The regression**: scanning a `.ts`-only fixture directory registers the
   expected entries. This is the case that fails before your fix.
2. Scanning a `.js`-only fixture directory still registers the expected entries.
3. Scanning a mixed `.ts`/`.js` fixture registers each module **once**, not
   twice.
4. A `.d.ts` file in the directory is ignored.
5. A missing directory returns an empty result without throwing (existing
   `ENOENT` behaviour — do not regress it).

**Verify**: `pnpm test` → exit 0, with the new specs passing.

### Step 4: Prove the tests detect the bug

Temporarily restore the old expression in one of the two files:

```ts
const MODULE_EXT = extname(import.meta.url || '') === '.ts' ? '.ts' : '.js';
```

Re-run that file's spec and confirm case 1 **fails**. Then restore your fix.

A test that passes both before and after the fix measures nothing. Do not skip
this step, and state in your report that you performed it and what you observed.

**Verify**: with the old expression restored, the `.ts`-only case fails; with
the fix restored, `pnpm test` → exit 0.

### Step 5: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **patch** bump, and describe it as a
fix: directory discovery of `app/workflows` and `app/steps` now finds `.ts`
modules in a dev app instead of silently registering nothing.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- New files: `packages/adonis/test/workflow-discovery.spec.ts` and
  `packages/adonis/test/step-discovery.spec.ts`, cases as enumerated in Step 3.
- Structural pattern: model on any existing spec under `packages/adonis/test/`
  (vitest, `expect`/`it`).
- Mutation check (Step 4) is part of the test plan, not optional.
- Verification: `pnpm test` → all pass, including the new specs.

## Done criteria

ALL must hold:

- [ ] `grep -rn "extname(import.meta.url" packages/adonis/src/` returns **no** matches
- [ ] Both new spec files exist and pass
- [ ] The mutation check in Step 4 was performed and case 1 failed without the fix
- [ ] The mixed `.ts`/`.js` fixture registers each module exactly once
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (or only the known `deps.spec.ts` failure documented in plan 001 remains)
- [ ] A changeset file exists in `.changeset/`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either file no longer contains the `extname(import.meta.url || '')`
  expression — someone already fixed this.
- Your fix would require changing the *signature* of `discoverWorkflows`,
  `registerWorkflowsFromDir`, or `registerStepsFromDir`. These are exported
  API on a published package; a signature change is out of scope for a bug fix.
- The de-duplication case (mixed `.ts`/`.js`) cannot be made to pass without
  changing behaviour the existing barrel path depends on.
- You find the scanners are also reached from the barrel path, contradicting
  this plan's assumption that only the fallback scan is affected.

## Maintenance notes

- Watch for a third copy of this expression appearing in any future scanner.
  The extracted shared helper from Step 1 is the guard against that; a reviewer
  should confirm the logic exists in exactly one place.
- This is the durable twin of a bug already fixed in `@adonis-agora/agent`'s
  tool discovery. If a third package grows a directory scanner, check it for the
  same pattern before shipping.
- The barrel path remains the recommended production setup; this fix makes the
  documented dev fallback behave as advertised, it does not change which path
  is preferred.

# Plan 007: Refuse to publish from a tree that does not lint, typecheck and test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- .github/workflows/release.yml package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md` (you need a
  green local suite to confirm the new gate passes rather than blocking a
  legitimate release)
- **Category**: dx
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

The release workflow runs `checkout → setup pnpm → setup node → npm install -g
npm → pnpm install → changesets/action`. It never runs lint, typecheck, or the
test suite, and it has no `needs:` linking it to the CI workflow. Its trigger is
`workflow_dispatch`, so it can be dispatched against any commit — including one
whose CI is red.

The `release` script itself only builds:

```json
"release": "pnpm --filter './packages/*' build && changeset publish"
```

npm publishes are effectively irreversible, and this package is peer-depended on
by other packages in the same family. One dispatch from a red commit ships a
broken version that cannot be recalled — only superseded.

This is a cheap gate that turns an unrecoverable mistake into a red workflow run.

## Current state

- `.github/workflows/release.yml` — the full job, with no verification step
  between install and publish:

  ```yaml
  jobs:
    release:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            fetch-depth: 0

        - uses: pnpm/action-setup@v6

        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: pnpm
            registry-url: 'https://registry.npmjs.org'

        - run: npm install -g 'npm@^11.5.1'

        - run: pnpm install --frozen-lockfile

        - name: Create release PR or publish
          uses: changesets/action@v1
          with:
            version: pnpm version-packages
            publish: pnpm release
  ```

- `package.json` scripts available to call — verified present:

  ```json
  "build": "turbo run build",
  "test": "turbo run test",
  "typecheck": "turbo run typecheck",
  "lint": "biome check .",
  "release": "pnpm --filter './packages/*' build && changeset publish",
  ```

- **Load-bearing details in this workflow that you must not disturb.** The file
  carries two comments explaining non-obvious decisions:
  - `npm install -g 'npm@^11.5.1'` is pinned to 11.x deliberately, **not**
    `@latest`, because npm 12 changed `npm info <pkg> --json` to return an array
    where 11 returned an object; changesets reads `pkgInfo.versions` off it, so
    on npm 12 every package looks unpublished and it republishes live versions.
  - `NODE_AUTH_TOKEN: ''` is deliberately empty so npm falls back to OIDC
    trusted publishing; a real token there would win over OIDC. `id-token: write`
    in `permissions` exists for the same reason.

  Both must survive this change untouched.

- Repo conventions: conventional commits. A CI-only change needs no changeset.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `pnpm lint` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| YAML sanity | `node -e "require('node:fs').readFileSync('.github/workflows/release.yml','utf8')"` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `.github/workflows/release.yml`

**Out of scope** (do NOT touch, even though they look related):
- `.github/workflows/ci.yml` — it already runs lint/typecheck/test and is green.
- The `permissions:` block, the `id-token: write` line, the
  `npm install -g 'npm@^11.5.1'` pin, and `NODE_AUTH_TOKEN: ''`. All are
  deliberate and documented in-file; changing any of them breaks trusted
  publishing or the changesets/npm interaction.
- `package.json`'s `release` script. Adding the checks there too would double-run
  them on every release for no extra safety, and would also run them in the
  version-PR path where they add latency without value. The workflow is the
  right place.
- The `concurrency` block.

## Git workflow

- Branch: `chore/gate-release-on-verification`
- One commit; message style: conventional commits, e.g.
  `chore(ci): gate release on lint, typecheck and test`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Insert the verification steps

In `.github/workflows/release.yml`, add three steps **between**
`- run: pnpm install --frozen-lockfile` and the
`- name: Create release PR or publish` step:

```yaml
      # A published version is effectively unrecallable, and `workflow_dispatch`
      # lets this run against any commit — including one whose CI is red. Verify
      # here rather than trusting the dispatcher to have checked.
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

Keep them as separate steps rather than one chained `&&` command, so the
workflow log shows which gate failed.

Order matters: lint and typecheck are fast and fail early; tests last.

**Verify**: `node -e "require('node:fs').readFileSync('.github/workflows/release.yml','utf8')"`
exits 0, and re-reading the file shows the three steps in position with correct
indentation (six spaces, matching the sibling steps).

### Step 2: Confirm the gate would pass today

Run each gate locally exactly as the workflow will:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If any of them fails, the gate you just added would block the next release. That
is the gate working correctly, but it means there is a real problem to fix
first — report it rather than weakening the gate.

Note: at the time this plan was written, `pnpm test` had one known failure,
`packages/adonis/test/engine/transports/bullmq/deps.spec.ts`, which times out
after 5s because it constructs a live ioredis client against `127.0.0.1:6379`.
CI has no Redis, so **this test will fail in the release workflow too**. See
Step 3.

**Verify**: you can state the exact pass/fail state of all three gates.

### Step 3: Handle the known failing test before the gate goes live

If `deps.spec.ts` still fails (Step 2), the gate you added will make every
release red. You must not ship a gate that is guaranteed to fail. Choose one and
say which in your report:

- **Preferred**: fix the test so it asserts the rejection without constructing a
  live ioredis client. Read
  `packages/adonis/test/engine/transports/bullmq/deps.spec.ts:23` — it asserts
  that `createBullMQDeps` rejects an undefined connection, but on the path where
  validation does not short-circuit it builds a real client that retries against
  localhost until vitest's timeout. Making the validation assertable without
  instantiation is a small, contained change.
- **Acceptable fallback**: if fixing it is not contained, report back and let the
  operator decide. Do **not** silently add `--passWithNoTests`, skip the file,
  or raise the timeout to mask it.

If `deps.spec.ts` was already fixed by another plan or by the operator, skip this
step and record that.

**Verify**: `pnpm test` → exit 0.

### Step 4: Confirm CI still passes

This change only touches `release.yml`, so `ci.yml` is unaffected — but confirm
you did not accidentally edit it:

```bash
git status --porcelain
```

**Verify**: only `.github/workflows/release.yml` appears as modified.

## Test plan

No new automated tests — this is a workflow change. The verification is:

- The three gates pass locally (Step 2).
- The YAML parses and the steps are correctly positioned and indented (Step 1).
- Only the intended file changed (Step 4).

The genuine end-to-end verification is the next release dispatch, which the
operator performs. Note this in your report.

## Done criteria

ALL must hold:

- [ ] `.github/workflows/release.yml` contains `- run: pnpm lint`, `- run: pnpm typecheck`, and `- run: pnpm test`
- [ ] All three appear **after** `pnpm install --frozen-lockfile` and **before** the `changesets/action@v1` step
- [ ] `grep -n "id-token: write" .github/workflows/release.yml` still matches
- [ ] `grep -n "npm@\^11.5.1" .github/workflows/release.yml` still matches
- [ ] `grep -n "NODE_AUTH_TOKEN: ''" .github/workflows/release.yml` still matches
- [ ] `pnpm lint` exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `git status --porcelain` shows only `.github/workflows/release.yml` (plus any test file changed under Step 3)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `release.yml` already runs any of the three commands — someone did this
  already.
- `pnpm test` fails for reasons **other** than the known `deps.spec.ts` timeout,
  and fixing them is not obviously in scope. A gate is only useful on a suite
  that can pass.
- Fixing `deps.spec.ts` (Step 3) turns out to require changing
  `createBullMQDeps`'s production behaviour rather than the test.
- You find yourself wanting to weaken the gate (skip a test, add a flag,
  raise a timeout) to make it green. That inverts the purpose of the plan.

## Maintenance notes

- The same gap exists in `adonis-authkit`, `adonis-telescope` and `adonis-agent`;
  each has its own copy of this plan. The four fixes are independent.
- A stronger version of this control is branch protection requiring the CI check
  before the "version packages" PR can merge. That is a repo-settings change,
  not a file change, so it is outside what an executor can do — worth raising
  with the operator as a complement to this plan, not a replacement.
- If CI later gains a Redis service (needed to un-skip the seven
  `REDIS_URL`-gated suites), the release gate will start exercising them too.
  That is desirable, but expect the release job to get slower.
- A reviewer should confirm the OIDC/npm-pin comments survived intact — they
  encode two expensive lessons.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Guards against the regression where `configure` was defined in `configure.ts` but reachable
 *  only via the `./configure` subpath — nothing AdonisJS resolves. `node ace configure` imports
 *  the package MAIN and reads `configure` off the module namespace, so this asserts against the
 *  *built* `dist/src/index.js`, not `src/index.ts`: a test against source would have passed even
 *  while the bug shipped. Mutation-proven by removing the re-export in src/index.ts, rebuilding,
 *  and confirming this fails. */
describe('configure hook export (built artifact)', () => {
  const distIndexUrl = new URL('../dist/src/index.js', import.meta.url);
  const distIndexPath = fileURLToPath(distIndexUrl);

  // A skip is dangerous *here* specifically. This spec's whole reason to exist is that the bug it
  // guards against already shipped once, and it shipped because a source-level check was green
  // while the built artifact was broken. Degrading to `it.skip` when `dist/` is missing reproduces
  // that failure shape one level up: the check disappears in exactly the environment where it is
  // load-bearing. CI starts from a fresh checkout, so `dist/` is absent there and present on a
  // developer's machine — the skip fires only in CI, and `pnpm test` gates the publish step. So the
  // missing build is a hard failure under CI and stays a convenience skip locally. If turbo.json's
  // `test` task ever loses its `build` dependency again, this is what says so out loud.
  if (!existsSync(distIndexPath)) {
    if (process.env.CI) {
      it('the built package main exports configure as a function', () => {
        expect.fail(
          [
            `${distIndexPath} does not exist, so this spec cannot check anything.`,
            'Under CI a missing build is a failure, not a skip: this is the only guard against',
            '`configure` being defined but not reachable from the package main — the regression',
            'that makes `node ace configure @adonis-agora/durable` a silent no-op, and that',
            'already shipped once. Skipping here would disable it precisely where it matters.',
            'Build before testing: `turbo run test` must depend on the durable package own',
            '`build` task (turbo.json -> tasks.test.dependsOn must include "build", not only',
            '"^build"), or the workflow must run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
    }
  } else {
    // ESM-importing the real dist artifact pulls in the whole package graph for the first time;
    // that takes ~0.5s alone but ~2s+ under full-suite load, so the default 5s testTimeout flakes.
    // 60s is a ceiling, not a target: loose enough that load never fails it, tight enough that a
    // genuinely hung import still fails the run. `pnpm test` is a release gate — a flake here
    // blocks publishes at random.
    it('the built package main exports configure as a function', async () => {
      const mod = (await import(distIndexUrl.href)) as Record<string, unknown>;
      expect(typeof mod.configure).toBe('function');
    }, 60_000);
  }
});

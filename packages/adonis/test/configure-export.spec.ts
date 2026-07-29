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

  if (!existsSync(distIndexPath)) {
    it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
  } else {
    it('the built package main exports configure as a function', async () => {
      const mod = (await import(distIndexUrl.href)) as Record<string, unknown>;
      expect(typeof mod.configure).toBe('function');
    });
  }
});

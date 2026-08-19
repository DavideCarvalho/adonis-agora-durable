import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import plugin, { VERSION } from '../src/index.js';

/** Guards the drift the plugin's `meta.version` had against `package.json` (it was left at `0.1.0`
 *  while the package shipped `0.2.x`). ESLint reports `meta.version` in `--print-config` and in
 *  bug-report output, so a stale literal misidentifies which build produced a report. Mirrors
 *  `packages/adonis/test/version.spec.ts`; `scripts/sync-version-literals.mjs` keeps it in sync on
 *  release. Mutation-proven by reverting the literal. */
describe('plugin meta.version', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string; name: string };

  it('matches the package.json version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('is what the plugin advertises to ESLint', () => {
    expect(plugin.meta).toEqual({ name: pkg.name, version: pkg.version });
  });
});

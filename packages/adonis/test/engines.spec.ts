import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards `engines.node` across every published package in the workspace.
 *
 * This field has now gone wrong twice, in opposite directions, and both times it shipped:
 *
 * 1. A hand edit ("align Node to CI") gave `@adonis-agora/durable` an upper bound of `<23` —
 *    mirroring the Node that CI happens to run, which says nothing about which runtimes the library
 *    supports. It was never applied to the sibling packages, so the ecosystem disagreed with itself.
 * 2. Renovate's global `rangeStrategy: "pin"` rewrote all three to the exact output of `node -v`.
 *
 * Both are the same mistake: `engines.node` declares the range of runtimes a package SUPPORTS, and
 * narrowing it to a development environment excludes real consumers. `<23` shipped in 0.24.0 and
 * broke an app on Node 24 under `engine-strict` — while nothing in the library actually fails there
 * (the full suite passes on Node 26). An exact pin warns on every install on any other Node.
 *
 * So: an open-ended floor, identical everywhere, and no ceiling unless someone can name the API that
 * breaks. If you are here because you added a real upper bound, this test is the place to document
 * WHY — and the bound then belongs on every package, not just one.
 */
const PUBLISHED_PACKAGES = ['adonis', 'dashboard', 'eslint-plugin'] as const;

/** The single supported range. Consumers of any Agora durable package see exactly this. */
const SUPPORTED_NODE = '>=20.6.0';

function manifest(pkg: string): { name: string; engines?: { node?: string } } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${pkg}/package.json`, import.meta.url)), 'utf8'),
  );
}

describe('engines.node', () => {
  for (const pkg of PUBLISHED_PACKAGES) {
    it(`packages/${pkg} declares the shared supported range`, () => {
      expect(manifest(pkg).engines?.node).toBe(SUPPORTED_NODE);
    });
  }

  it('declares no upper bound anywhere — a ceiling excludes consumers already on newer Node', () => {
    for (const pkg of PUBLISHED_PACKAGES) {
      expect(manifest(pkg).engines?.node ?? '').not.toMatch(/<|<=/);
    }
  });

  it('is a range, not a pinned version — an exact value warns on every foreign-Node install', () => {
    for (const pkg of PUBLISHED_PACKAGES) {
      expect(manifest(pkg).engines?.node ?? '').not.toMatch(/^v?\d+\.\d+\.\d+$/);
    }
  });
});

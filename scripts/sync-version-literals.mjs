#!/usr/bin/env node
/**
 * Keeps every exported `VERSION` literal in sync with its own package's `version` — the literals
 * have no other link to the manifest (no build-time codegen, no JSON import), so `changeset version`
 * bumping the manifest alone silently drifts them (each package has a `test/version.spec.ts` that
 * exists specifically to catch that drift in CI).
 *
 * Run as the last step of the root `version-packages` script, right after `changeset version`
 * writes the new `package.json`, so a release always ships with the literals already matching —
 * no `version.spec.ts` should ever fail on a release branch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Each package that exports a `VERSION` literal, with the files carrying it. */
const packages = [
  {
    dir: 'packages/adonis',
    literalFiles: ['packages/adonis/src/index.ts', 'packages/adonis/src/dashboard/index.ts'],
  },
  {
    dir: 'packages/eslint-plugin',
    literalFiles: ['packages/eslint-plugin/src/index.ts'],
  },
];

const VERSION_LINE = /^export const VERSION = '[^']*';$/m;

for (const { dir, literalFiles } of packages) {
  const pkgPath = `${repoRoot}${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version;
  if (!version) {
    throw new Error(`sync-version-literals: no "version" field in ${pkgPath}`);
  }

  for (const relative of literalFiles) {
    const file = `${repoRoot}${relative}`;
    const source = readFileSync(file, 'utf8');
    if (!VERSION_LINE.test(source)) {
      throw new Error(
        `sync-version-literals: no "export const VERSION = '...'" line found in ${file}`,
      );
    }
    const updated = source.replace(VERSION_LINE, `export const VERSION = '${version}';`);
    if (updated !== source) {
      writeFileSync(file, updated);
      console.log(`sync-version-literals: ${file} -> ${version}`);
    }
  }
}

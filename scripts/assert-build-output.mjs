#!/usr/bin/env node
/**
 * Post-condition for package `build` scripts: refuse to let a build exit 0 when it
 * emitted no JavaScript.
 *
 * Why this exists: `tsc` with `incremental: true` treats its `.tsbuildinfo` as the
 * record of what is already on disk. Delete `dist/` but leave the buildinfo behind and
 * `tsc` concludes every output is current and emits nothing — exit code 0, empty
 * `dist/`. Turbo then caches that empty directory as a successful `build`, and serves
 * it to every later run. `prepack` has no turbo in front of it at all, so a manual
 * `pnpm publish` from such a tree would ship a package with no code in it.
 *
 * The build script now removes `dist/` and builds with `incremental: false`, so the
 * stale-state trigger is gone. This check is the belt to that pair of braces: it runs
 * inside the build itself, so it protects the `prepack` path too, and it fires before
 * turbo can write a vacuum into the cache.
 *
 * Usage, from a package directory:
 *   node ../../scripts/assert-build-output.mjs <dist-dir> [required-file...]
 * where required files are relative to <dist-dir>.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [distArg, ...requiredFiles] = process.argv.slice(2);

if (!distArg) {
  fail('usage: assert-build-output.mjs <dist-dir> [required-file...]');
}

const cwd = process.cwd();
const distDir = resolve(cwd, distArg);

function fail(message) {
  console.error(`\nbuild post-condition failed: ${message}\n`);
  process.exit(1);
}

function countJsFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countJsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      total += 1;
    }
  }
  return total;
}

const recovery = [
  'How to recover:',
  // Both globs on purpose: the buildinfo files here are dotfiles, and a shell `*` does
  // not match those. `rm -rf dist *.tsbuildinfo` alone leaves the stale state in place.
  `  rm -rf ${distArg} .*tsbuildinfo *.tsbuildinfo`,
  '  pnpm run build',
  '',
  'If that produces JavaScript, the tree had stale incremental state: tsc believed',
  'its outputs were already on disk and emitted nothing. Do NOT publish a tree in',
  'this state — package `files` ships dist/, so the tarball would contain no code.',
].join('\n');

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail(`${distArg} does not exist after the build.\n\n${recovery}`);
}

const jsFiles = countJsFiles(distDir);
if (jsFiles === 0) {
  fail(`${distArg} contains no JavaScript after the build (0 .js files).\n\n${recovery}`);
}

for (const required of requiredFiles) {
  if (!existsSync(resolve(distDir, required))) {
    fail(
      `${distArg} is missing the required entrypoint ${required}, though it does ` +
        `contain ${jsFiles} .js file(s).\n\n${recovery}`,
    );
  }
}

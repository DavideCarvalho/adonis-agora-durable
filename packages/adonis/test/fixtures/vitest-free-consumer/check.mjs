/**
 * Imports and USES `@adonis-agora/durable/testing` from a consumer app that has no vitest — the
 * Japa/node:test case. `vitest` is an OPTIONAL peer dependency, so this has to work; it once did
 * not (`/testing` was one barrel that re-exported two conformance generators which import `vitest`
 * unconditionally), and a real app on Japa hit `Cannot find package 'vitest'` and hand-rolled the
 * harness the library already ships.
 *
 * WHY A SEPARATE PROCESS, AND A COPY.
 *  - A spec running under vitest cannot prove this. `vitest` is in the repo's node_modules, so it
 *    resolves whether or not the bug is present, and the check passes vacuously.
 *  - The package is COPIED, not symlinked. Node resolves symlinks by default, so a symlinked
 *    package would resolve `vitest` from ITS real location (packages/adonis/node_modules, which
 *    has vitest) and the check would pass vacuously in a second way.
 *  - It runs against the BUILT dist, through the `exports` map, so it also covers what the
 *    existing static import-graph walk over `src/` cannot: a mis-pointed `./testing` export, a
 *    dynamic `await import('vitest')`, or a dependency that drags vitest in transitively.
 *
 * Exits 0 on success, non-zero with a message on failure. Driven by `vitest-free-consumer.spec.ts`.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));

const appRoot = mkdtempSync(join(tmpdir(), 'durable-vitest-free-'));
const fail = (message) => {
  console.error(`vitest-free consumer: ${message}`);
  rmSync(appRoot, { recursive: true, force: true });
  process.exit(1);
};

const installed = join(appRoot, 'node_modules/@adonis-agora/durable');
mkdirSync(installed, { recursive: true });
writeFileSync(
  join(appRoot, 'package.json'),
  '{ "name": "durable-vitest-free-app", "type": "module", "private": true }\n',
);
cpSync(join(pkgRoot, 'package.json'), join(installed, 'package.json'));
cpSync(join(pkgRoot, 'dist'), join(installed, 'dist'), { recursive: true });

// The importer has to live INSIDE the scratch app, or Node would resolve bare specifiers by walking
// up from this file — straight back into the repo, where vitest exists.
const importerPath = join(appRoot, 'importer.mjs');
writeFileSync(
  importerPath,
  `export const kit = await import('@adonis-agora/durable/testing');
export async function importConformance() {
  return import('@adonis-agora/durable/testing/conformance');
}
`,
);

try {
  // ── negative control: vitest really is unreachable from in there ─────────────────────────────
  const requireFromApp = createRequire(importerPath);
  let vitestResolvable = true;
  try {
    requireFromApp.resolve('vitest');
  } catch {
    vitestResolvable = false;
  }
  if (vitestResolvable) {
    fail('vitest IS resolvable from the scratch app, so nothing below proves anything.');
  }

  // ── the testing kit imports ─────────────────────────────────────────────────────────────────
  const { kit, importConformance } = await import(pathToFileURL(importerPath).href);

  const required = [
    'createTestEngine',
    'MutableClock',
    'assertRunStatus',
    'assertOutput',
    'assertStepsRan',
    'assertStepAttempts',
    'recordedSteps',
    'assertReplayable',
    'assertTransportConformance',
    'failOnce',
    'failTimes',
  ];
  const missing = required.filter((name) => typeof kit[name] !== 'function');
  if (missing.length > 0) fail(`missing (or not a function) in /testing: ${missing.join(', ')}`);

  // ── and works: import-only would not prove the helpers are usable ───────────────────────────
  const t = kit.createTestEngine();
  t.engine.register('vitest-free', '1', async (ctx) => {
    const doubled = await ctx.localStep('double', kit.failOnce(42), { retries: 2 });
    return { doubled };
  });
  const result = await t.run('vitest-free', {}, 'vf-run');
  if (result.status !== 'completed') fail(`run settled as ${result.status}, expected completed`);

  await kit.assertRunStatus(t.store, 'vf-run', 'completed');
  await kit.assertOutput(t.store, 'vf-run', { doubled: 42 });
  await kit.assertStepsRan(t.store, 'vf-run', ['double']);
  await kit.assertStepAttempts(t.store, 'vf-run', 'double', 2);

  // The assertions must also REJECT a false claim, or all of the above shows is that they import.
  let rejected = false;
  try {
    await kit.assertRunStatus(t.store, 'vf-run', 'failed');
  } catch {
    rejected = true;
  }
  if (!rejected) fail('assertRunStatus accepted a status the run does not have');

  // ── the conformance subpath is where the vitest dependency lives, and it stays there ─────────
  // Not a nice-to-have: if this ever succeeds here, the two `describe`/`it` generators have leaked
  // back into a graph that must stay runner-agnostic, and `/testing` is one refactor from breaking
  // for every Japa consumer again.
  let conformanceError;
  try {
    await importConformance();
  } catch (err) {
    conformanceError = err;
  }
  if (!conformanceError) {
    fail('/testing/conformance imported with no vitest installed — it must be the subpath that needs it');
  }
  if (!/vitest/.test(conformanceError.message)) {
    fail(`/testing/conformance failed for the wrong reason: ${conformanceError.message}`);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log('vitest-free consumer: OK');

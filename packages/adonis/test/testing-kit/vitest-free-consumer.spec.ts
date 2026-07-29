import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * `vitest` is an OPTIONAL peer dependency: any app should be able to use the test harness
 * (`createTestEngine`, the assertions, fault injection, deterministic replay) with whatever runner
 * it likes, and pay for `vitest` only when it opts into the conformance contracts. That promise was
 * broken once — `/testing` was a single barrel re-exporting two conformance generators that import
 * `vitest` unconditionally, so importing anything from `/testing` required vitest to be resolvable.
 * A real app on Japa hit `Cannot find package 'vitest'` and hand-rolled the harness instead.
 *
 * This is the acceptance test for that promise, and it is deliberately a CONSUMER rather than a unit
 * test. `no-vitest-in-testing-barrel.spec.ts` covers the same property by statically walking `src/`'s
 * import graph — necessary, because an `import()` from inside this repo's vitest-powered suite would
 * pass whether or not the bug were present. But a static walk over source cannot see a mis-pointed
 * `./testing` entry in the `exports` map, a dynamic `await import('vitest')`, or a transitive
 * dependency that drags vitest in. So this one runs the built package the way an app installs it,
 * from a directory where vitest genuinely does not resolve. See
 * `test/fixtures/vitest-free-consumer/check.mjs`.
 */
describe('the testing kit is usable from a consumer with no vitest (built artifact)', () => {
  const harness = fileURLToPath(
    new URL('../fixtures/vitest-free-consumer/check.mjs', import.meta.url),
  );
  const distIndex = fileURLToPath(new URL('../../dist/src/index.js', import.meta.url));

  // Same reasoning as `configure-export.spec.ts`: an artifact-level check means nothing without the
  // artifact, CI starts from a fresh checkout, and `pnpm test` gates the publish. So a missing
  // `dist/` is a hard failure under CI and a convenience skip on a developer machine.
  if (!existsSync(distIndex)) {
    if (process.env.CI) {
      it('imports and uses /testing from an app that has no vitest installed', () => {
        expect.fail(
          [
            `${distIndex} does not exist, so this spec cannot check anything.`,
            'It is the only check that the published `exports` map lets a Japa app import the test',
            'harness; under CI a missing build is a failure, not a skip. Run `pnpm build` before',
            '`pnpm test`, or restore turbo.json -> tasks.test.dependsOn including this package own',
            '"build".',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
    }
  } else {
    // Copies dist (~3MB, 500 files) into a temp app and runs a workflow: fast alone, slower under
    // full suite load. 60s is a ceiling, not a target — `pnpm test` is a release gate and a flake
    // here would block publishes at random.
    it('imports and uses /testing from an app that has no vitest installed', async () => {
      // `NODE_PATH` and `NODE_OPTIONS` MUST NOT be inherited. Vitest sets NODE_PATH to its own
      // node_modules and children inherit it, which makes `vitest` resolvable from ANY directory —
      // including a scratch app that has nothing installed. Leaving it in place is how this check
      // becomes theatre: the runner would smuggle in the very package whose absence is the point.
      // The harness has its own negative control (`require.resolve('vitest')` must throw) so a
      // regression here fails loudly instead of passing vacuously.
      // Filtered rather than `delete`d: an `undefined` value in `env` is not reliably the same as
      // an absent key across platforms, and absent is the whole requirement.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== 'NODE_PATH' && key !== 'NODE_OPTIONS',
        ),
      );
      const { stdout } = await execFileAsync(process.execPath, [harness], {
        timeout: 55_000,
        env,
      });
      expect(stdout).toContain('vitest-free consumer: OK');
    }, 60_000);
  }
});

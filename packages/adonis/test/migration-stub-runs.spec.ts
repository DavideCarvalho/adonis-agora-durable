import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * The stub no longer carries DDL — it calls `createDurableTables` / `dropDurableTables`. That trades
 * one risk for another: a DDL snapshot could go stale but could never fail to RUN, whereas a stub
 * that calls into the library breaks the moment that API moves. A stub that does not run is worse
 * than a stale one, so this asserts it runs: real `MigrationRunner`, real SQLite file, real store
 * write, then rollback.
 *
 * It has to be a child process. `@adonisjs/lucid/services/db` (what gives the stub the `Database`
 * manager `createDurableTables` needs) resolves `container.make(Database)` off the app service when
 * its module body evaluates, so it only works inside a booted app; and the harness resolves
 * `@adonis-agora/durable` by name from a scratch app directory, which lands on the BUILT `dist`
 * rather than on `src` the way an in-process vitest import would. See
 * `test/fixtures/stub-migration/run.mjs`.
 */
describe('the durable migration stub runs (built artifact, real migrator)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-migration/run.mjs', import.meta.url));
  const distIndex = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

  // Same reasoning as `configure-export.spec.ts`: this spec only means something against a built
  // package, CI starts from a fresh checkout, and `pnpm test` gates the publish. So a missing
  // `dist/` is a hard failure under CI and a convenience skip on a developer machine.
  if (!existsSync(distIndex)) {
    if (process.env.CI) {
      it('renders the stub into a scratch app and migrates a real database', () => {
        expect.fail(
          [
            `${distIndex} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated migration actually executes; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`, or',
            'restore turbo.json -> tasks.test.dependsOn including this package own "build".',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
    }
  } else {
    // Boots an AdonisJS app, creates a SQLite file, runs two migrations: ~2s cold, more under full
    // suite load. 60s is a ceiling, not a target — loose enough never to flake, tight enough that a
    // genuinely hung migration (the `pool: { max: 1 }` deadlock this harness is built to catch)
    // still fails instead of hanging the run.
    it('renders the stub into a scratch app and migrates a real database', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 55_000 });
      expect(stdout).toContain('stub migration harness: OK');
    }, 60_000);
  }
});

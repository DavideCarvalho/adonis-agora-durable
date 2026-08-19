import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template that
 * no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace configure` / `make:workflow`. The package's own typecheck compiles `src/` against the
 * library's own types, which are trivially happy with themselves; the sibling stub specs assert that
 * the migration stub delegates (`migration-stub-schema`) and that it runs (`migration-stub-runs`), but
 * both operate on JavaScript and cannot see a type error.
 *
 * The failure mode is not hypothetical: `@adonis-agora/agent` shipped a migration whose `up()` did not
 * compile in a consumer app, because its structural `rawQuery` declared `bindings?: unknown[]` — not
 * assignable in either direction to Lucid's `RawQueryBindings`, so no per-connection client satisfied
 * it. Its whole suite stayed green.
 *
 * Durable does not have that defect: `createDurableTables(db: Database, connectionName?: string)`
 * imports Lucid's real `Database` rather than mirroring it structurally, so there is no variance
 * mismatch to hit, and its own `lucid.ts` call site already exercises the `string` connection name.
 * This spec is preventive — it makes the property permanent instead of incidental.
 *
 * Covers all five stubs that emit typed code (both migrations, both config files, and the
 * `make:workflow` output), each compiled under NodeNext + strict with the package resolved BY NAME —
 * so what is checked is the shipped `dist/**\/*.d.ts` a consumer installs, not `src/`.
 */
describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  // Resolving the package by name makes a built package a precondition. Same policy as the sibling
  // stub specs: a hard failure under CI (where `pnpm test` gates the publish), a convenience skip on
  // a developer machine who has not built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated code COMPILES for a consumer; under CI a missing',
            'build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Lucid + Adonis declaration graph is a few seconds; 90s is a ceiling that
    // will not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});

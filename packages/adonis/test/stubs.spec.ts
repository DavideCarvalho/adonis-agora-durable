import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { describe, expect, it } from 'vitest';

/**
 * What `node ace configure @adonis-agora/durable` and `node ace make:workflow` actually hand a user.
 *
 * A `.stub` is a template no tsconfig `include` reaches and no import graph touches, so the whole
 * build / typecheck / test pipeline can be green while the generator is broken. This package shipped
 * exactly that: Adonis compiles a stub BODY with Tempura, which builds it into a JavaScript template
 * literal, so a backtick or a `${` in the body terminates that literal early and the stub throws at
 * generation time. Four of the five stubs carried backticks in their doc comments — meaning
 * `configure` aborted on the first one and wrote no config and no migrations at all.
 *
 * The sibling `stub-typecheck` spec compiles the rendered output; this one guards the step before it,
 * that there IS output. Both drive the real `app.stubs` pipeline — the same one
 * `codemods.makeUsingStub` runs — because a hand-written renderer is what let the defect through in
 * the first place: it reported five healthy stubs for a package whose `configure` could not write a
 * single file.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const stubsRoot = join(packageRoot, 'stubs');

/** Every `.stub` file under `dir`, relative to the package root. */
function findStubs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findStubs(full));
    else if (entry.name.endsWith('.stub')) found.push(relative(packageRoot, full));
  }
  return found;
}

// Source stubs, plus the copies `copy:stubs` places in `dist/` once the build has run — a stub that
// is correct in `stubs/` but mangled by the copy step would still reach users.
const stubFiles = [...findStubs(stubsRoot), ...findStubs(join(packageRoot, 'dist', 'stubs'))];

/** Every stub the package generates, with the state its generator supplies. */
const PUBLISHED: { path: string; entity?: string }[] = [
  { path: 'config/durable.stub' },
  { path: 'config/durable_dashboard.stub' },
  { path: 'database/migrations/create_durable_tables.stub' },
  { path: 'database/migrations/create_durable_transport_tables.stub' },
  // Not published by `configure` — emitted by `node ace make:workflow <name>`.
  { path: 'make/workflow/main.stub', entity: 'order' },
];

describe('published stubs', () => {
  it('covers every stub in the package', () => {
    const sources = findStubs(stubsRoot).map((file) => relative('stubs', file));
    expect(sources.sort()).toEqual(PUBLISHED.map((s) => s.path).sort());
  });

  it.each(stubFiles)('%s is not empty', (file) => {
    const bytes = statSync(join(packageRoot, file)).size;
    expect(bytes, `${file} is empty — the generator would publish a blank file`).toBeGreaterThan(0);
  });

  it.each(stubFiles)('%s keeps its body free of backticks and ${ }', (file) => {
    // Scoped to the BODY on purpose. The `{{{ … }}}` header is evaluated as JavaScript, so the
    // migrations' `app.migrationsPath(\`${…}_create_durable_tables.ts\`)` is legitimate — and
    // necessary — there and only there. A whole-file scan would fail it and invite someone to
    // "fix" a header that is correct.
    const contents = readFileSync(join(packageRoot, file), 'utf8');
    const body = contents.replace(/\{\{\{[\s\S]*?\}\}\}/, '');

    expect(
      body,
      `${file}: a backtick in the body ends Tempura's template literal — the generator throws`,
    ).not.toContain('`');
    expect(
      body,
      `${file}: a \${ } in the body is evaluated as an interpolation — the generator throws`,
    ).not.toContain('${');
  });

  /**
   * The check that actually proves it. The text assertions above describe the two constructs known
   * to break Tempura today; this one asks the real renderer, so a construct nobody has thought of
   * still fails here rather than in a user's terminal.
   */
  describe('render through the real Adonis stubs pipeline', () => {
    it.each(PUBLISHED)('$path renders to a non-empty file', async ({ path, entity }) => {
      const app = new AppFactory().create(new URL('file:///stub-render-scratch/'));
      await app.init();
      const stubs = await app.stubs.create();

      const stub = await stubs.build(path, { source: stubsRoot });
      const state = entity ? { entity: app.generators.createEntity(entity) } : {};
      const prepared = await stub.prepare(state);

      expect(prepared.attributes.to, `${path} must declare a destination`).toBeTruthy();
      expect(
        prepared.contents.length,
        `${path} rendered to nothing — the generator would publish a blank file`,
      ).toBeGreaterThan(0);
      expect(prepared.contents, `${path} left unrendered template syntax`).not.toMatch(/\{\{/);
    });
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { describe, expect, it } from 'vitest';

/**
 * What `node ace configure @adonis-agora/durable` and `node ace make:workflow` actually hand a user.
 *
 * A `.stub` is a template no tsconfig `include` reaches and no import graph touches, so the whole
 * build / typecheck / test pipeline can be green while the generator is broken. Two distinct defects
 * have shipped through that hole, and both are covered here.
 *
 * 1. **A stub that does not RENDER.** Adonis compiles a stub body with Tempura, which builds it into
 *    a JavaScript template literal, so an UNESCAPED backtick or `${` in the body terminates that
 *    literal early and the stub throws at generation time. Four of the five stubs here carried plain
 *    backticks in their doc comments, and `configure` renders `config/durable.stub` first — so every
 *    published version updated `adonisrc.ts` and then died, leaving a half-configured app.
 *
 * 2. **A stub emptied or dropped by tooling.** `copy:stubs` is a loose `cp` in the build script, so
 *    nothing fails if it skips a file, and an ecosystem-wide de-backticking pass emptied published
 *    stubs elsewhere while the sources still looked fine. Source-vs-dist divergence is therefore a
 *    real failure mode, not a hypothetical one — which is why the two trees are compared as SETS and
 *    byte-for-byte, and why `dist/` is rendered rather than trusted.
 *
 * Everything below drives the real `app.stubs` pipeline — the same one `codemods.makeUsingStub`
 * runs. A hand-written renderer is what let defect 1 survive review: it reported five healthy stubs
 * for a package whose `configure` could not write a single file.
 *
 * NOTE ON WHAT IS **NOT** ASSERTED: there is deliberately no "the body contains no backtick" rule.
 * An escaped backtick is legitimate and renders to a real backtick, so a ban would forbid the correct
 * fix and push authors into rewriting prose that is doing useful work. A ban would also only ever
 * catch the two constructs already known to break. Renderability is the stronger, style-agnostic
 * property: it catches whatever Tempura chokes on next, and needs no body-vs-header carve-out.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceStubs = join(packageRoot, 'stubs');
const distStubs = join(packageRoot, 'dist', 'stubs');

/** Every `.stub` under `root`, as paths relative to `root`. */
function findStubs(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.stub')) found.push(relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

/** Every stub the package generates, with the state its generator supplies. */
const PUBLISHED: { path: string; entity?: string }[] = [
  { path: 'config/durable.stub' },
  { path: 'config/durable_dashboard.stub' },
  { path: 'database/migrations/create_durable_tables.stub' },
  { path: 'database/migrations/create_durable_transport_tables.stub' },
  // Not published by `configure` — emitted by `node ace make:workflow <name>`.
  { path: 'make/workflow/main.stub', entity: 'order' },
];

/**
 * Which trees to check. `dist/` is what a consumer installs, so it is the one that actually matters;
 * it exists only after a build. Same policy as the sibling stub specs: a hard failure under CI (where
 * `pnpm test` gates the publish), a convenience skip on a developer machine that has not built yet.
 */
const hasDist = existsSync(distStubs);
const TREES = [
  { label: 'stubs', root: sourceStubs },
  ...(hasDist ? [{ label: 'dist/stubs', root: distStubs }] : []),
];

describe('published stubs', () => {
  it('the source tree holds exactly the stubs this package generates', () => {
    expect(findStubs(sourceStubs)).toEqual(PUBLISHED.map((s) => s.path).sort());
  });

  if (hasDist) {
    it('dist/stubs holds exactly the same SET of files as the source tree', () => {
      // `copy:stubs` is a loose `cp` outside the compiler's knowledge: nothing fails if it skips a
      // file, and a stub missing from `dist/` is simply absent from every per-file check below
      // rather than failing one. This is the assertion that turns that silence into a failure.
      expect(findStubs(distStubs)).toEqual(findStubs(sourceStubs));
    });

    it.each(PUBLISHED.map((s) => s.path))(
      'dist/stubs/%s is byte-identical to its source',
      (path) => {
        // Catches a copy step that truncates, empties, or rewrites — the shape that shipped blank
        // stubs elsewhere while the sources still read correctly.
        expect(readFileSync(join(distStubs, path), 'utf8')).toBe(
          readFileSync(join(sourceStubs, path), 'utf8'),
        );
      },
    );
  } else if (process.env.CI) {
    it('dist/stubs exists', () => {
      expect.fail(
        'dist/stubs is missing, so the files a consumer actually installs went unchecked. Run `pnpm build` before `pnpm test`.',
      );
    });
  } else {
    it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/durable build` first', () => {});
  }

  /**
   * The check that actually proves it: build each stub through the real pipeline `configure` uses.
   * A stub that cannot render throws here with the same message the user would have seen.
   */
  describe.each(TREES)('render $label through the real Adonis stubs pipeline', ({ root }) => {
    it.each(PUBLISHED)('$path renders to a non-empty file', async ({ path, entity }) => {
      const app = new AppFactory().create(new URL('file:///stub-render-scratch/'));
      await app.init();
      const stubs = await app.stubs.create();

      const stub = await stubs.build(path, { source: root });
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

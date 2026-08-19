/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/durable` and `@adonisjs/*` by NAME, with each stub rendered into the file
 * it actually generates, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves. The sibling stub specs assert that the
 * migration stub delegates (`migration-stub-schema`) and that it runs (`migration-stub-runs`), but
 * both operate on JavaScript, so neither can see a type error. That leaves a stub free to reference a
 * shape the real `@adonisjs/lucid` types reject while the whole suite stays green — which is exactly
 * how `@adonis-agora/agent` shipped a migration whose `up()` did not compile: its structural
 * `rawQuery` declared `bindings?: unknown[]`, not assignable in either direction to Lucid's
 * `RawQueryBindings`, so no per-connection client satisfied it.
 *
 * Durable does not have that defect — `createDurableTables(db: Database, connectionName?: string)`
 * imports Lucid's real `Database` type rather than mirroring it structurally, so there is no variance
 * mismatch to hit. This harness is the gate that keeps it that way: it compiles against the shipped
 * `dist/**\/*.d.ts`, so changing that signature tomorrow fails here instead of in a consumer's app.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED declarations a consumer installs — not `src/`,
 * which a check run inside this repo would otherwise pick up.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Every stub that generates TYPED TypeScript, with the path `configure` / `make:workflow` writes it
 * to. A stub that emits no type-bearing code has nothing to check; all five of these import from the
 * package and would break a consumer's build if their signatures drifted.
 */
const STUBS = [
  { stub: 'database/migrations/create_durable_tables.stub', to: 'database/migrations/1785200000000_create_durable_tables.ts' },
  { stub: 'database/migrations/create_durable_transport_tables.stub', to: 'database/migrations/1785200000001_create_durable_transport_tables.ts' },
  { stub: 'config/durable.stub', to: 'config/durable.ts' },
  { stub: 'config/durable_dashboard.stub', to: 'config/durable_dashboard.ts' },
  { stub: 'make/workflow/main.stub', to: 'app/workflows/order_workflow.ts', entity: 'order' },
];

/**
 * Render a stub the way the generator does. Two template constructs appear in these stubs: the
 * `{{{ exports(...) }}}` destination header, and (in `make:workflow` only) `{{#var name = ... }}`
 * declarations plus `{{ name }}` interpolations.
 *
 * Deliberately strict: anything left unrendered is a hard failure rather than a silent pass. A stub
 * that grows a template construct this renderer does not model would otherwise reach `tsc` with
 * literal braces in it — which reads as a compile error nobody can explain, or worse, gets "fixed"
 * by loosening the check until it stops looking at anything.
 */
function render({ stub, entity }) {
  const source = readFileSync(join(pkgRoot, 'stubs', stub), 'utf8');

  let out = source.replace(/^\{\{#var[^\n]*\n/gm, '');
  const withoutHeader = out.replace(/\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (withoutHeader === out) throw new Error(`no {{{ exports() }}} header in ${stub} — render assumption broken`);
  out = withoutHeader;

  if (entity) {
    // What `make:workflow <entity>` computes for the three `{{#var}}` bindings above.
    const pascal = entity.replace(/(^|[_-])(\w)/g, (_, __, c) => c.toUpperCase());
    out = out
      .replaceAll('{{ workflowName }}', pascal)
      .replaceAll('{{ registeredName }}', entity);
  }

  const leftover = out.match(/\{\{.*?\}\}/);
  if (leftover) throw new Error(`unrendered template syntax ${leftover[0]} left in ${stub}`);
  return out;
}

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve
 * every peer they import (`@adonisjs/lucid`, `@adonisjs/core`) plus anything the published
 * declarations transitively reference (`zod`, luxon via Lucid's types). Scoped directories are
 * recreated as real directories so `@adonis-agora/durable` can be added alongside without writing
 * into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer
 * dependency is picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → `dist/**/*.d.ts`.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/durable'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'durable-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'durable-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );
  linkDependencies(appRoot);

  for (const spec of STUBS) {
    const target = join(appRoot, spec.to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, render(spec));
  }

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig`
   * sets. Both matter — NodeNext is what makes the package's `exports` map (and therefore its
   * subpath declarations) the thing being resolved, and `strict` is what turns a variance mismatch
   * from a silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          experimentalDecorators: true,
        },
        include: ['database/**/*.ts', 'config/**/*.ts', 'app/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log(`stub typecheck: OK (${STUBS.length} stubs)`);

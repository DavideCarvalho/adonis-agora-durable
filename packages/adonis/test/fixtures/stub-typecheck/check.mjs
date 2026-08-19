/**
 * Type-checks every PUBLISHED stub the way a consumer app receives it: rendered by the REAL Adonis
 * stubs pipeline into a scratch app that depends on `@adonis-agora/durable` and `@adonisjs/*` by
 * NAME, then compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate here. The package's own typecheck compiles `src/` against the library's own types,
 * which are trivially happy with themselves. The sibling stub specs assert that the migration stub
 * delegates (`migration-stub-schema`) and that it runs (`migration-stub-runs`), but both operate on
 * JavaScript, so neither can see a type error.
 *
 * WHY THE REAL RENDERER. This harness first shipped with a hand-written regex renderer, and that made
 * it worse than useless: it reported five green stubs for a package whose `configure` could not write
 * a single file. Adonis compiles a stub body with Tempura, into a JavaScript template literal — so a
 * backtick or a `${` in the body terminates that literal early and the stub throws at generation
 * time. Four of the five stubs did exactly that. A regex renderer does not model Tempura, so it
 * sailed past the defect and type-checked text no user could ever obtain.
 *
 * A gate that renders differently from the generator is not testing the generator. So this drives
 * `app.stubs.create()` → `build()` → `prepare()` — the same pipeline `codemods.makeUsingStub` runs
 * from `configure.ts` — and writes each result at the very path the stub declares.
 *
 * Resolution matters as much as compilation: the scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs, not
 * `src/`, which a check run inside this repo would otherwise pick up.
 *
 * Exits 0 on success; on failure prints the diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const stubsRoot = join(pkgRoot, 'stubs');

/**
 * Every stub that generates TYPED TypeScript. The four `configure` publishes, plus the
 * `make:workflow` output — all five import from the package and would break a consumer's build if
 * their signatures drifted. `state` is what the generator passes: only `make:workflow` needs an
 * entity, exactly as its command supplies one.
 */
const STUBS = [
  { path: 'config/durable.stub' },
  { path: 'config/durable_dashboard.stub' },
  { path: 'database/migrations/create_durable_tables.stub' },
  { path: 'database/migrations/create_durable_transport_tables.stub' },
  { path: 'make/workflow/main.stub', entity: 'order' },
];

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

  // The real pipeline, rooted at the scratch app — so each stub's own `exports({ to })` resolves to a
  // path inside it and the file lands exactly where `configure` would put it.
  const app = new AppFactory().create(pathToFileURL(`${appRoot}/`));
  await app.init();
  const stubs = await app.stubs.create();

  for (const { path, entity } of STUBS) {
    let prepared;
    try {
      const stub = await stubs.build(path, { source: stubsRoot });
      const state = entity ? { entity: app.generators.createEntity(entity) } : {};
      prepared = await stub.prepare(state);
    } catch (error) {
      // A stub that cannot RENDER never reaches tsc. Report it as the generator failure it is —
      // this is the exact message a user would get from `node ace configure`.
      console.error(`stub typecheck: FAILED — ${path} does not render at all`);
      console.error(`  ${error.message}`);
      console.error('  A backtick or a ${ } in the stub BODY ends Tempura\'s template literal.');
      process.exit(1);
    }

    if (!prepared.attributes.to) throw new Error(`${path} declared no destination`);
    if (prepared.contents.length === 0) throw new Error(`${path} rendered to nothing`);

    mkdirSync(dirname(prepared.attributes.to), { recursive: true });
    writeFileSync(prepared.attributes.to, prepared.contents);
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

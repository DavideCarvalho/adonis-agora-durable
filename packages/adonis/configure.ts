import { readFile, writeFile } from 'node:fs/promises';
import type Configure from '@adonisjs/core/commands/configure';
import { mergeSubpathImports } from './src/configure-imports.js';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/durable` — auto-wires the package:
 *
 * 1. registers the core service provider in `adonisrc.ts`;
 * 2. registers the ace commands barrel (five commands: `durable:work`,
 *    `durable:worker`, `durable:runs`, `durable:retry`, `make:workflow`);
 * 3. registers the optional dashboard provider;
 * 4. registers the Assembler `init` hooks that generate the typed `app/workflows`
 *    and `app/steps` barrels at build/dev time (the provider imports them instead
 *    of scanning at runtime; each falls back to the runtime scan when its barrel
 *    is absent);
 * 5. adds the `#workflows/*` and `#steps/*` subpath imports to the app's `package.json`,
 *    which the generated barrels import through (without them the app boots into
 *    `ERR_PACKAGE_IMPORT_NOT_DEFINED`);
 * 6. publishes `config/durable.ts` + `config/durable_dashboard.ts`;
 * 7. publishes the Lucid migrations for the optional `lucid` store and `db`
 *    transport drivers (run `node ace migration:run`, and delete the transport
 *    migration if you don't use the `db` transport).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/durable/durable_provider');
    rcFile.addProvider('@adonis-agora/durable/dashboard_provider');
    rcFile.addCommand('@adonis-agora/durable/commands');
    // Generate the typed app/workflows + app/steps barrels at build/dev time (each replaces its
    // runtime readdir scan; the provider falls back to the scan when a barrel is absent).
    rcFile.addAssemblerHook('init', '@adonis-agora/durable/hooks/workflows');
    rcFile.addAssemblerHook('init', '@adonis-agora/durable/hooks/steps');
  });

  await addSubpathImports(command);

  await codemods.makeUsingStub(stubsRoot, 'config/durable.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'config/durable_dashboard.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_durable_tables.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_durable_transport_tables.stub',
    {},
  );
}

/**
 * Add the subpath imports the generated barrels resolve through. There is no codemod for the
 * `imports` map, so this edits `package.json` directly — and only when something is missing, so a
 * second `configure` run neither rewrites the file nor logs a change it did not make.
 */
async function addSubpathImports(command: Configure) {
  const path = command.app.makePath('package.json');

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    command.logger.warning(
      'could not read package.json — add "#workflows/*": "./app/workflows/*.js" and "#steps/*": "./app/steps/*.js" to its "imports" by hand',
    );
    return;
  }

  const pkg = JSON.parse(raw) as { imports?: Record<string, string> };
  const { imports, added } = mergeSubpathImports(pkg.imports);
  if (added.length === 0) return;

  pkg.imports = imports;
  // Two-space JSON with a trailing newline: what `create-adonisjs` writes, so the diff stays to
  // the added lines instead of reformatting the whole file.
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  command.logger.action(`update package.json (imports: ${added.join(', ')})`).succeeded();
}

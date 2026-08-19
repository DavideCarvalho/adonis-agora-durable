import type Configure from '@adonisjs/core/commands/configure';
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
 * 5. publishes `config/durable.ts` + `config/durable_dashboard.ts`;
 * 6. publishes the Lucid migrations for the optional `lucid` store and `db`
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

  await codemods.makeUsingStub(stubsRoot, 'config/durable.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'config/durable_dashboard.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_durable_tables.stub', {});
  await codemods.makeUsingStub(
    stubsRoot,
    'database/migrations/create_durable_transport_tables.stub',
    {},
  );
}

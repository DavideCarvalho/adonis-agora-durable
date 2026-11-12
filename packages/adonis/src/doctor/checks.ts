import type { ApplicationService } from '@adonisjs/core/types';
import type { DurableConfig } from '../define_config.js';
import { type AgoraDoctorCheck, type AgoraDoctorResult, installedVersion } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable';

type AnyConfig = Record<string, unknown> & Partial<DurableConfig>;

function durableConfig(app: ApplicationService): AnyConfig | undefined {
  return app.config.get<AnyConfig | undefined>('durable', undefined);
}

function topologyOf(config: AnyConfig | undefined): string {
  return typeof config?.topology === 'string' ? config.topology : 'standalone';
}

/** `durable.config`: `config/durable.ts` resolves and uses no removed key. */
export function checkConfig(config: AnyConfig | undefined): AgoraDoctorResult {
  if (config === undefined) {
    return {
      status: 'warn',
      message: 'config/durable.ts is missing: the engine runs in memory with every default.',
      fix: 'Run `node ace configure @adonis-agora/durable` to create config/durable.ts.',
      docs: `${DOCS}/getting-started`,
    };
  }
  if ('role' in config) {
    return {
      status: 'error',
      message: `config/durable.ts sets \`role: ${JSON.stringify(config.role)}\`, which is not an option: the cluster shape is \`topology\`.`,
      fix: 'Rename `role` to `topology` in config/durable.ts.',
      docs: `${DOCS}/cluster/topology-and-config`,
    };
  }
  const topology = topologyOf(config);
  if (!['standalone', 'control-plane', 'tenant'].includes(topology)) {
    return {
      status: 'error',
      message: `\`topology: ${JSON.stringify(topology)}\` is not one of standalone, control-plane, tenant.`,
      fix: 'Set `topology` to standalone, control-plane or tenant in config/durable.ts.',
      docs: `${DOCS}/cluster/topology-and-config`,
    };
  }
  if (config.store !== undefined && config.stores?.[config.store] === undefined) {
    return {
      status: 'error',
      message: `\`store: '${config.store}'\` names no entry of \`stores\`.`,
      fix: `Add a '${config.store}' entry to \`stores\` in config/durable.ts, or change \`store\`.`,
      docs: `${DOCS}/stores`,
    };
  }
  if (config.transport !== undefined && config.transports?.[config.transport] === undefined) {
    return {
      status: 'error',
      message: `\`transport: '${config.transport}'\` names no entry of \`transports\`.`,
      fix: `Add a '${config.transport}' entry to \`transports\` in config/durable.ts, or change \`transport\`.`,
      docs: `${DOCS}/transports`,
    };
  }
  return { status: 'ok', message: `config/durable.ts is valid (topology ${topology}).` };
}

/** `durable.verify-tenant`: a control plane that verifies the tenants calling it. */
export function checkVerifyTenant(
  config: AnyConfig | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (topologyOf(config) !== 'control-plane') {
    return { status: 'skip', message: 'Not a control plane.' };
  }
  if (config?.verifyTenant !== undefined) {
    return { status: 'ok', message: 'The control plane verifies tenant tokens.' };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message:
      "topology is 'control-plane' and verifyTenant is not set: any caller can act as a tenant.",
    fix: 'Set `verifyTenant` in config/durable.ts (hmacTenantVerifier or an authkit verifier).',
    docs: `${DOCS}/cluster/authenticate-tenants`,
  };
}

/** `durable.tenant-token`: a tenant pod that presents a token. */
export function checkTenantToken(config: AnyConfig | undefined): AgoraDoctorResult {
  if (topologyOf(config) !== 'tenant') return { status: 'skip', message: 'Not a tenant pod.' };
  const token = (config?.tenant as { token?: unknown } | undefined)?.token;
  if (token === undefined || token === null || token === '') {
    return {
      status: 'error',
      message:
        "topology is 'tenant' and tenant.token is not set: the control plane cannot tell who this pod is.",
      fix: 'Set `tenant: { token }` in config/durable.ts (a string, a function or a credentials class).',
      docs: `${DOCS}/cluster/authenticate-tenants`,
    };
  }
  return { status: 'ok', message: 'The tenant pod presents a token.' };
}

/** `durable.cron-parser`: cron schedules need cron-parser 5. */
export async function checkCronParser(
  config: AnyConfig | undefined,
  appRoot: string,
): Promise<AgoraDoctorResult> {
  const schedules = Array.isArray(config?.schedules) ? config.schedules : [];
  const usesCron = schedules.some((s) => typeof (s as { cron?: unknown }).cron === 'string');
  if (!usesCron && config?.persistedSchedules !== true) {
    return { status: 'skip', message: 'No cron schedules.' };
  }
  const version = await installedVersion('cron-parser', appRoot);
  if (version === null) {
    return {
      status: usesCron ? 'error' : 'warn',
      message: 'Cron schedules need the cron-parser package, which is not installed.',
      fix: 'Install it: npm install cron-parser',
      docs: `${DOCS}/authoring/scheduling`,
    };
  }
  const major = Number(version.split('.')[0]);
  if (major !== 5) {
    return {
      status: 'error',
      message: `cron-parser ${version} is installed; durable reads cron-parser 5.`,
      fix: 'Install cron-parser 5: npm install cron-parser@5',
      docs: `${DOCS}/authoring/scheduling`,
    };
  }
  return { status: 'ok', message: `cron-parser ${version}.` };
}

/** `durable.store-tables` (deep): with `autoSchema: false`, the run tables exist. */
export async function checkStoreTables(app: ApplicationService): Promise<AgoraDoctorResult> {
  const config = durableConfig(app);
  if (topologyOf(config) === 'tenant' || config?.store === undefined) {
    return { status: 'skip', message: 'No SQL store in this process.' };
  }
  if (config.autoSchema !== false) {
    return { status: 'skip', message: 'autoSchema creates the tables at boot.' };
  }
  const { WorkflowEngine } = await import('../engine.js');
  try {
    const engine = await app.container.make(WorkflowEngine);
    await engine.listRuns({ page: 1, size: 1 });
    return { status: 'ok', message: 'The durable tables answer.' };
  } catch (error) {
    return {
      status: 'error',
      message: `Reading durable_workflow_runs failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      fix: 'Create the tables with a migration that calls createDurableTables(db, connection), then run it.',
      docs: `${DOCS}/stores/lucid`,
    };
  }
}

/** The store surface the schema check reads (the Lucid store has it). */
interface SchemaInspectable {
  schemaName: string | undefined;
  inspectSchema(): Promise<{
    schema: string | undefined;
    schemaExists: boolean;
    missingTables: string[];
    writeError: string | undefined;
  }>;
}

/**
 * `durable.schema` (deep): with a `schema` on the SQL store (its own or the top-level one), the
 * schema exists, the durable tables are in it, and the connection can write there. Skipped (and so
 * silent) without one.
 */
export async function checkSchema(app: ApplicationService): Promise<AgoraDoctorResult> {
  const config = durableConfig(app);
  const factory = config?.store !== undefined ? config.stores?.[config.store] : undefined;
  if (topologyOf(config) === 'tenant' || factory === undefined) {
    return { status: 'skip', message: 'No SQL store in this process.' };
  }
  let store: Partial<SchemaInspectable>;
  try {
    store = (await factory({
      app,
      ...(config?.schema !== undefined ? { schema: config.schema } : {}),
    })) as Partial<SchemaInspectable>;
  } catch (error) {
    if (config?.schema === undefined) return { status: 'skip', message: 'No `schema` is set.' };
    return {
      status: 'error',
      message: `The store could not be built with schema "${config.schema}": ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Use a valid schema name on a Postgres or MySQL connection.',
      docs: `${DOCS}/stores/lucid#database-schema`,
    };
  }
  if (typeof store.inspectSchema !== 'function' || store.schemaName === undefined) {
    return { status: 'skip', message: 'No `schema` is set.' };
  }
  const { schema, schemaExists, missingTables, writeError } = await store.inspectSchema();
  if (!schemaExists) {
    return {
      status: 'error',
      message: `The schema "${schema}" does not exist.`,
      fix: `Boot once with autoSchema on (it creates the schema), or run CREATE SCHEMA "${schema}" (CREATE DATABASE on MySQL) and the durable migrations.`,
      docs: `${DOCS}/stores/lucid#database-schema`,
    };
  }
  if (missingTables.length > 0) {
    return {
      status: 'error',
      message: `The schema "${schema}" lacks ${missingTables.join(', ')}.`,
      fix: `Boot once with autoSchema on, or run the durable migrations with the same \`schema\`.`,
      docs: `${DOCS}/stores/lucid#database-schema`,
    };
  }
  if (writeError !== undefined) {
    return {
      status: 'error',
      message: `The connection cannot write to the schema "${schema}": ${writeError.split('\n')[0]}`,
      fix: `Grant the connection's role USAGE on the schema and INSERT/UPDATE/DELETE on its tables.`,
      docs: `${DOCS}/stores/lucid#database-schema`,
    };
  }
  return {
    status: 'ok',
    message: `The durable tables are in the schema "${schema}" and writable.`,
  };
}

/** `durable.console-gate`: the console has an `authorize`. */
export function checkConsoleGate(
  dashboard: Record<string, unknown> | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (dashboard === undefined) {
    return { status: 'skip', message: 'The durable console is not configured.' };
  }
  if (dashboard.enabled === false) return { status: 'skip', message: 'The console is disabled.' };
  if (dashboard.authorize !== undefined) {
    return { status: 'ok', message: 'The console has an authorize.' };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message: inProduction
      ? 'The console has no authorize: it denies every request in production.'
      : 'The console has no authorize: it is open here and denies every request in production.',
    fix: 'Set `authorize` in config/durable_dashboard.ts.',
    docs: `${DOCS}/observability/dashboard`,
  };
}

/** The checks `@adonis-agora/durable`'s provider registers. */
export const durableDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'durable.config',
    lib: 'durable',
    title: 'Config is valid',
    run: (app) => checkConfig(durableConfig(app)),
  },
  {
    id: 'durable.verify-tenant',
    lib: 'durable',
    title: 'Control plane verifies tenants',
    run: (app) => checkVerifyTenant(durableConfig(app), app.inProduction),
  },
  {
    id: 'durable.tenant-token',
    lib: 'durable',
    title: 'Tenant pod presents a token',
    run: (app) => checkTenantToken(durableConfig(app)),
  },
  {
    id: 'durable.cron-parser',
    lib: 'durable',
    title: 'cron-parser for cron schedules',
    run: (app) => checkCronParser(durableConfig(app), app.makePath()),
  },
  {
    id: 'durable.store-tables',
    lib: 'durable',
    title: 'Durable tables exist',
    cost: 'deep',
    run: (app) => checkStoreTables(app),
  },
  {
    id: 'durable.schema',
    lib: 'durable',
    title: 'Durable tables in their schema',
    cost: 'deep',
    run: (app) => checkSchema(app),
  },
];

/** The check the durable console's provider registers. */
export const durableConsoleDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'durable.console-gate',
    lib: 'durable',
    title: 'Console access in production',
    run: (app) =>
      checkConsoleGate(
        app.config.get<Record<string, unknown> | undefined>('durable_dashboard', undefined) ?? {},
        app.inProduction,
      ),
  },
];

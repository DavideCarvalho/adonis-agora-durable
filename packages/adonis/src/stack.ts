/**
 * What durable runs on, for telescope's Architecture page ("durable: run history → PostgreSQL").
 *
 * Telescope reads `config/durable.ts` after boot and looks for a list of uses under the global
 * symbol `@adonis-agora/stack`. Each factory (`stores.lucid()`, `transports.db()`, …) records what it
 * would use; `defineConfig` (and the provider, once the app's `database` config can resolve the
 * default connection) puts the uses of the SELECTED drivers on the config object. A factory listed
 * in the config but not selected is not described. No dependency on telescope.
 */

/** The symbol telescope reads a lib's infrastructure under. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** What a driver uses (the shape telescope reads). */
export interface StackUse {
  tech: string;
  connection?: string;
  purpose?: string;
  label?: string;
  host?: string;
}

/** Attach `uses` to `target`, non-enumerable. Never throws (a frozen object stays undescribed). */
export function describeStackUse<T extends object>(target: T, uses: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(uses) ? uses : [uses],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // frozen: nothing to describe
  }
  return target;
}

/** What a factory would use, before the app's config resolves its defaults. */
export type StackHint =
  /** A Lucid connection (the default one when `connection` is unset). */
  | {
      kind: 'lucid';
      connection?: string | undefined;
      purpose: string;
      /** Only when the app has a `database` config (a driver that falls back without Lucid). */
      ifLucid?: boolean;
    }
  /** An `@adonisjs/redis` connection (`main` when unset, as the factories do). */
  | { kind: 'redis'; connection?: string | undefined; purpose: string }
  /** A raw ioredis connection (options, a URL or an instance). */
  | { kind: 'ioredis'; connection: unknown; label: string; purpose: string };

const hints = new WeakMap<object, StackHint[]>();

/**
 * The hints also ride on the factory under a global symbol, so a wrapper (a `Proxy`, like
 * `encryptedTransport` from `@adonis-agora/crypto-integrations`) still carries them: the WeakMap
 * only knows the original object.
 */
const HINTS = Symbol.for('@adonis-agora/durable:stack-hints');

/** Record what `factory` would use. Returns `factory`. */
export function hintStack<T extends object>(factory: T, list: StackHint[]): T {
  hints.set(factory, list);
  try {
    Object.defineProperty(factory, HINTS, { value: list, enumerable: false, configurable: true });
  } catch {
    // a frozen factory: the WeakMap still has it
  }
  return factory;
}

/** What `factory` would use (empty for an in-process driver or a ready instance). */
export function stackHintsOf(factory: unknown): StackHint[] {
  if (factory === null || (typeof factory !== 'object' && typeof factory !== 'function')) return [];
  const known = hints.get(factory);
  if (known !== undefined) return known;
  try {
    const carried = (factory as Record<symbol, unknown>)[HINTS];
    return Array.isArray(carried) ? (carried as StackHint[]) : [];
  } catch {
    return [];
  }
}

interface AppConfigLike {
  get(key: string, defaultValue?: unknown): unknown;
}

const DB_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  'pg-native': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

function read(appConfig: AppConfigLike | undefined, key: string): unknown {
  try {
    return appConfig?.get(key);
  } catch {
    return undefined;
  }
}

function ioredisHost(connection: unknown): string | undefined {
  if (typeof connection === 'string') {
    try {
      const url = new URL(connection);
      return `${url.hostname}:${url.port}${url.pathname}`;
    } catch {
      return undefined;
    }
  }
  if (connection !== null && typeof connection === 'object') {
    const c = connection as { host?: unknown; port?: unknown; db?: unknown; options?: unknown };
    // An ioredis instance keeps its options under `options`.
    const o = (typeof c.host === 'string' ? c : (c.options ?? {})) as typeof c;
    if (typeof o.host === 'string')
      return `${o.host}:${String(o.port ?? '')}/${String(o.db ?? '')}`;
  }
  return undefined;
}

function resolveHint(hint: StackHint, appConfig: AppConfigLike | undefined): StackUse {
  if (hint.kind === 'redis') {
    return { tech: 'redis', connection: hint.connection ?? 'main', purpose: hint.purpose };
  }
  if (hint.kind === 'ioredis') {
    const host = ioredisHost(hint.connection);
    return {
      tech: 'redis',
      label: hint.label,
      purpose: hint.purpose,
      ...(host !== undefined ? { host } : {}),
    };
  }
  const primary = read(appConfig, 'database.connection');
  const connection = hint.connection ?? (typeof primary === 'string' ? primary : undefined);
  const client =
    connection !== undefined
      ? read(appConfig, `database.connections.${connection}.client`)
      : undefined;
  const tech = (typeof client === 'string' ? DB_TECH[client] : undefined) ?? 'sql';
  return {
    tech,
    ...(connection !== undefined ? { connection } : {}),
    purpose: hint.purpose,
  };
}

interface DescribableConfig {
  store?: unknown;
  stores?: Record<string, unknown>;
  transport?: unknown;
  transports?: Record<string, unknown>;
  transportPool?: unknown;
  admission?: unknown;
  controlPlane?: unknown;
}

/**
 * The uses of the drivers `config` selects: its `store`, its `transport` and `transportPool`, its
 * `admission` and `controlPlane`. `appConfig` (the app's config) resolves the default Lucid
 * connection and its technology; without it, an unset Lucid connection stays unnamed.
 */
export function durableStackUses(config: unknown, appConfig?: AppConfigLike): StackUse[] {
  if (config === null || typeof config !== 'object') return [];
  const c = config as DescribableConfig;
  const factories: unknown[] = [];
  if (typeof c.store === 'string') factories.push(c.stores?.[c.store]);
  const transportNames = new Set<string>();
  if (typeof c.transport === 'string') transportNames.add(c.transport);
  if (Array.isArray(c.transportPool)) {
    for (const name of c.transportPool) if (typeof name === 'string') transportNames.add(name);
  }
  for (const name of transportNames) factories.push(c.transports?.[name]);
  factories.push(c.admission, c.controlPlane);

  const uses: StackUse[] = [];
  const seen = new Set<string>();
  const hasLucid = read(appConfig, 'database') !== undefined;
  for (const factory of factories) {
    for (const hint of stackHintsOf(factory)) {
      if (hint.kind === 'lucid' && hint.ifLucid === true && !hasLucid) continue;
      const use = resolveHint(hint, appConfig);
      const key = JSON.stringify(use);
      if (seen.has(key)) continue;
      seen.add(key);
      uses.push(use);
    }
  }
  return uses;
}

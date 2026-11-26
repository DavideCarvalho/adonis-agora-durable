/**
 * This app's key, the same way in every Agora lib (SECURITY-UNIFORM-SPEC §13c): `config/app.ts`'s
 * `appKey`, else the default entry of `config/encryption.ts` (AdonisJS 7: `list[default]`, else the
 * first entry; its first usable key, `keys[...]` or `key`; the lazy config providers `defineConfig`
 * and `drivers.*` return are resolved first), else the `APP_KEY` environment variable. A `Secret`
 * (`release()`) or a string; never logged. A source that throws counts as "no key here".
 */
export type AppKey = string | { release(): string };

interface AppLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

const present = (value: unknown): value is AppKey => {
  if (typeof value === 'string') return value.length > 0;
  if (value === null || typeof value !== 'object') return false;
  const release = (value as { release?: unknown }).release;
  if (typeof release !== 'function') return false;
  try {
    const raw = (value as { release(): unknown }).release();
    return typeof raw === 'string' && raw.length > 0;
  } catch {
    return false;
  }
};

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolved(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first key of an encryption config entry, whatever its shape (`keys[...]`, `key`). */
function keyOfEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) return keys.find((k) => present(k));
  return key;
}

/** The key of `config/encryption.ts`: its default entry's first key (a flat config as is). */
async function encryptionKeyOf(app: unknown): Promise<unknown> {
  let raw: unknown;
  try {
    raw = (app as AppLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolved(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined ? undefined : keyOfEntry(await resolved(entries[chosen], app));
  }
  return keyOfEntry(config);
}

/** The app's key (see the module comment), or `undefined`. */
export async function appKeyOf(app: unknown): Promise<AppKey | undefined> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  if (present(fromApp)) return fromApp;
  const fromEncryption = await encryptionKeyOf(app);
  if (present(fromEncryption)) return fromEncryption;
  const fromEnv = process.env.APP_KEY;
  return present(fromEnv) ? fromEnv : undefined;
}

/**
 * Zero-config `topology: 'tenant'`: when `@adonis-agora/authkit-client` is booted in the app with its
 * `service` configured, its `'authkit.client'` binding answers `tenantOf(resource)` with this app's
 * control-plane URL (discovered from the issuer), a service token for the resource (cached, with
 * `reset()`) and its partition. Detected by shape, never imported: no dependency on authkit-client.
 *
 * Merge rule: `{ ...auto, ...config.tenant }`, field by field. Anything set explicitly wins, and
 * `tenant: { auto: false }` turns the detection off.
 */

/** What `authkit.client.tenantOf(resource)` answers. */
export interface AuthkitTenant {
  url: (() => Promise<string>) & { refresh?(): Promise<string> };
  token: (() => Promise<string>) & { reset?(): void };
  partition: string;
}

/** The part of the `'authkit.client'` binding this module uses. */
export interface AuthkitTenantClient {
  tenantOf(resource: string): AuthkitTenant | Promise<AuthkitTenant>;
}

/** Where a tenant field comes from. */
export type TenantFieldSource = 'explicit' | 'authkit-client (auto)' | 'missing';

export type TenantField = 'url' | 'token' | 'partition';

interface ContainerLike {
  hasBinding?(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

/** The fields of a `tenant` block this module reads and fills. */
export interface TenantIdentityFields {
  url?: unknown;
  token?: unknown;
  partition?: unknown;
  /** `false`: never fill a field from authkit-client. */
  auto?: boolean | undefined;
}

/**
 * `@adonis-agora/authkit-client`'s `'authkit.client'` binding when it is booted here AND has
 * `tenantOf` (1.1+); an older authkit-client, or none, is `undefined`. A binding that is registered
 * but fails to build comes back as `error`.
 */
export async function authkitTenantClientOf(
  container: ContainerLike | undefined,
): Promise<{ client?: AuthkitTenantClient; error?: string }> {
  if (!container || typeof container.hasBinding !== 'function') return {};
  if (!container.hasBinding('authkit.client')) return {};
  let client: unknown;
  try {
    client = await container.make('authkit.client');
  } catch (error) {
    return { error: `resolving 'authkit.client' failed: ${messageOf(error)}` };
  }
  const candidate = client as Partial<AuthkitTenantClient> | null | undefined;
  return candidate && typeof candidate.tenantOf === 'function'
    ? { client: candidate as AuthkitTenantClient }
    : {};
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

export interface ResolvedTenantIdentity<T> {
  /** `{ ...auto, ...explicit }` (only the requested fields are filled). */
  tenant: T;
  /** Where each requested field came from. */
  sources: Partial<Record<TenantField, TenantFieldSource>>;
  /** The requested fields nothing supplied. */
  missing: TenantField[];
  /** Why authkit-client could not supply them (its `tenantOf` threw), when it did. */
  authkitError?: string;
  /** Whether a usable `authkit.client` (with `tenantOf`) is booted here. */
  authkit: boolean;
}

/**
 * Fills the missing `fields` of `explicit` from `authkit.client.tenantOf(resource)`. `tenantOf` is
 * only called when a field is missing, so an app with every field explicit (or with authkit-client
 * for login only, and no `service`) is unaffected.
 */
export async function resolveTenantIdentity<T extends TenantIdentityFields>(
  explicit: T | undefined,
  options: {
    container: ContainerLike | undefined;
    resource: string;
    fields: readonly TenantField[];
  },
): Promise<ResolvedTenantIdentity<T>> {
  const base = { ...(explicit ?? {}) } as T;
  const sources: Partial<Record<TenantField, TenantFieldSource>> = {};
  const wanted = options.fields.filter((field) => {
    if (present(base[field])) {
      sources[field] = 'explicit';
      return false;
    }
    return true;
  });
  const found =
    wanted.length > 0 && base.auto !== false ? await authkitTenantClientOf(options.container) : {};
  const client = found.client;
  let authkitError: string | undefined = found.error;
  if (client && wanted.length > 0) {
    let auto: AuthkitTenant | undefined;
    try {
      // authkit-client 1.1 answers synchronously and throws `TenantOfConfigError`
      // (`E_AUTHKIT_SERVICE_NOT_CONFIGURED`) without `service`: authkit then counts as absent, and
      // its message joins the boot error. Awaited so an async `tenantOf` works too.
      auto = await client.tenantOf(options.resource);
    } catch (error) {
      authkitError = messageOf(error);
    }
    if (auto) {
      for (const field of wanted) {
        const value = auto[field];
        if (present(value)) {
          (base as Record<string, unknown>)[field] = value;
          sources[field] = 'authkit-client (auto)';
        }
      }
    }
  }
  const missing = wanted.filter((field) => sources[field] === undefined);
  for (const field of missing) sources[field] = 'missing';
  return {
    tenant: base,
    sources,
    missing,
    authkit: client !== undefined,
    ...(authkitError !== undefined ? { authkitError } : {}),
  };
}

/**
 * The boot error for a tenant with fields nothing supplied: names them, and both fixes.
 */
export function missingTenantFieldsMessage(input: {
  lib: string;
  configFile: string;
  resource: string;
  missing: readonly TenantField[];
  /** The explicit form to suggest, e.g. `tenant: { url, token, partition }`. */
  explicitForm: string;
  authkitError?: string | undefined;
  autoDisabled?: boolean | undefined;
}): string {
  const fields = input.missing.map((field) => `tenant.${field}`).join(', ');
  const cause = input.authkitError
    ? ` authkit-client could not supply them (${input.authkitError}).`
    : input.autoDisabled
      ? ' `tenant.auto` is false, so authkit-client does not supply them.'
      : '';
  return `[@adonis-agora/${input.lib}] topology 'tenant' needs ${fields}.${cause} Fix: configure @adonis-agora/authkit-client's \`service: { name, clientId, clientSecret }\` (config/authkit_client.ts), which supplies them for ${input.resource}, or set \`${input.explicitForm}\` in ${input.configFile}.`;
}

/** The marker between a boot error's problem and its fix (see {@link missingTenantFieldsMessage}). */
const FIX_MARKER = ' Fix: configure @adonis-agora/authkit-client';

/** A boot error split for a doctor result: the problem, and the fix when the message carries one. */
export function splitTenantError(text: string): { message: string; fix?: string } {
  const at = text.lastIndexOf(FIX_MARKER);
  if (at === -1) return { message: text };
  return { message: text.slice(0, at), fix: text.slice(at + ' Fix: '.length) };
}

/**
 * One doctor line of where each field came from, grouped by source:
 * `tenant url/token/partition: authkit-client (auto)`, or
 * `tenant url: explicit; token/partition: authkit-client (auto)`.
 */
export function describeTenantSources(
  sources: Partial<Record<TenantField, TenantFieldSource>>,
  order: readonly TenantField[] = ['url', 'token', 'partition'],
): string {
  const groups = new Map<TenantFieldSource, TenantField[]>();
  for (const field of order) {
    const source = sources[field];
    if (source === undefined) continue;
    groups.set(source, [...(groups.get(source) ?? []), field]);
  }
  return `tenant ${[...groups.entries()].map(([source, fields]) => `${fields.join('/')}: ${source}`).join('; ')}`;
}

/* -------------------------------------------------------------------------------------------- */
/* durable                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** The resource durable's tenant tokens are for. */
export const DURABLE_TENANT_RESOURCE = 'urn:agora:durable';

/** The fields durable reads: tenants reach the control plane through `transport`, not a URL. */
export const DURABLE_TENANT_FIELDS: readonly TenantField[] = ['token', 'partition'];

/** A tenant pod's identity, resolved: `partition` is always there. */
export interface DurableTenantIdentity<T> {
  tenant: T & { partition: string };
  sources: Partial<Record<TenantField, TenantFieldSource>>;
}

/**
 * `config.tenant` with authkit-client's `partition`/`token` filled in where they are missing. Throws
 * the boot error when no `partition` resolves (the token stays optional, as it always was).
 */
export async function resolveDurableTenant<T extends TenantIdentityFields>(
  tenant: T | undefined,
  container: ContainerLike | undefined,
): Promise<DurableTenantIdentity<T>> {
  const resolved = await resolveTenantIdentity(tenant, {
    container,
    resource: DURABLE_TENANT_RESOURCE,
    fields: DURABLE_TENANT_FIELDS,
  });
  if (resolved.missing.includes('partition')) {
    throw new Error(
      missingTenantFieldsMessage({
        lib: 'durable',
        configFile: 'config/durable.ts',
        resource: DURABLE_TENANT_RESOURCE,
        missing: resolved.missing,
        explicitForm: 'tenant: { partition, token }',
        authkitError: resolved.authkitError,
        autoDisabled: tenant?.auto === false,
      }),
    );
  }
  return {
    tenant: resolved.tenant as T & { partition: string },
    sources: resolved.sources,
  };
}

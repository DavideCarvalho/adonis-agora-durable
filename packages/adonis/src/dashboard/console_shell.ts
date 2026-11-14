import type { HttpContext } from '@adonisjs/core/http';
import { isSameOriginPath } from './console_switcher.js';

/** A same-origin path with no backslash or control character (what the SPA will follow). */
function safePath(path: unknown): path is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  return isSameOriginPath(path) && !path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path);
}

/*
 * The console shell's "who is here" and "how to leave" — the `viewer` and `signOut` fields of the
 * page's JSON data block (CONSOLE-SHELL-SPEC). Everything is read STRUCTURALLY: this package depends
 * on neither `@adonisjs/auth`, `@adonisjs/shield` nor authkit.
 */

/** Who is signed in, as the sidebar footer shows it. */
export interface ConsoleViewer {
  /** Main line: a name or an email. */
  label: string;
  email?: string;
  /** Small caps line under it (`admin`). */
  role?: string;
}

/** How the footer signs out: a POST form (with the CSRF token) or a plain link. */
export type ConsoleSignOut = { action: string; csrfToken?: string } | { href: string };

/** The `signOut` config option: a POST action path, `{ action }`, `{ href }`, or `false` for none. */
export type SignOutOption = string | { action: string } | { href: string } | false;

/** The `viewer` config hook: return the viewer, or `null`/`undefined` for no user row. */
export type ViewerHook = (
  ctx: HttpContext,
) => ConsoleViewer | null | undefined | Promise<ConsoleViewer | null | undefined>;

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

/** A role's name: a string, or an object's `name` / `role` (an authz role row has `role`). */
function roleName(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value);
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as { name?: unknown; role?: unknown };
  return text(r.name) ?? text(r.role);
}

/** Every role name in a field that is one role or a list of them. */
function roleNames(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const item of list) {
    const name = roleName(item);
    if (name) names.push(name);
  }
  return names;
}

/** The one role the footer shows: the first admin-like one (`ADMIN`, `org_admin`), else the first. */
export function pickRole(names: readonly string[]): string | undefined {
  return names.find((name) => /admin/i.test(name)) ?? names[0];
}

/** Read a property without letting a throwing getter escape. */
function read(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The roles a user object carries: `role`, `roles` (strings, `{ name }` or `{ role }` rows) and
 * `globalRoles`, in that order.
 */
function rolesOf(user: unknown): string[] {
  return [
    ...roleNames(read(user, 'role')),
    ...roleNames(read(user, 'roles')),
    ...roleNames(read(user, 'globalRoles')),
  ];
}

/**
 * A viewer from any user-ish object: `fullName` / `name` / `email` for the label, `email`, and one
 * role from `role` / `roles` / `globalRoles` plus `extraRoles` (an admin-like one first, else the
 * first). `undefined` when nothing usable is there.
 */
export function viewerFromUser(
  user: unknown,
  extraRoles: readonly string[] = [],
): ConsoleViewer | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const email = text(read(user, 'email'));
  const label = text(read(user, 'fullName')) ?? text(read(user, 'name')) ?? email;
  if (!label) return undefined;
  const role = pickRole([...rolesOf(user), ...extraRoles]);
  return { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
}

/** How long the footer waits for authkit's per-request identity before giving up on the role. */
const IDENTITY_TIMEOUT_MS = 250;

/**
 * The global roles of authkit's per-request identity (`ctx.authkit`), read structurally: the
 * already-resolved `identity` when there is one, else `getIdentity()` (memoized per request) under
 * a short timeout. Any failure means no roles.
 */
async function authkitRoles(ctx: HttpContext): Promise<string[]> {
  const authkit = read(ctx, 'authkit');
  if (typeof authkit !== 'object' || authkit === null) return [];
  let identity = read(authkit, 'identity');
  const getIdentity = read(authkit, 'getIdentity');
  if ((identity === null || identity === undefined) && typeof getIdentity === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      identity = await Promise.race([
        Promise.resolve(getIdentity.call(authkit)),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), IDENTITY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      identity = undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  return roleNames(read(identity, 'globalRoles'));
}

/** Keep only the fields the SPA renders, as trimmed non-empty strings. */
function cleanViewer(value: unknown): ConsoleViewer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const label = text(v.label);
  if (!label) return undefined;
  const email = text(v.email);
  const role = text(v.role);
  return { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
}

/**
 * The viewer for this request: the host's `viewer(ctx)` hook when configured (a throw or an empty
 * answer means no user row), else a structural read of `ctx.auth?.user` — only when the request is
 * already authenticated; it never triggers an authentication. The fallback's role also looks at
 * authkit's per-request identity (`ctx.authkit`, its `globalRoles`) once a user is there.
 */
export async function resolveViewer(
  ctx: HttpContext,
  hook: ViewerHook | null | undefined,
): Promise<ConsoleViewer | undefined> {
  if (hook) {
    try {
      return cleanViewer(await hook(ctx));
    } catch {
      return undefined;
    }
  }
  // `read` swallows guards that throw on `.user` before authentication: that just means "no viewer".
  const user = read(read(ctx, 'auth'), 'user');
  if (!viewerFromUser(user)) return undefined;
  return viewerFromUser(user, await authkitRoles(ctx));
}

/** The request's CSRF token when `@adonisjs/shield` (or anything like it) put one on the request. */
export function csrfTokenOf(ctx: HttpContext): string | undefined {
  const token = (ctx.request as unknown as { csrfToken?: unknown }).csrfToken;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

/** What a registry's `account.signOut` (announced by authkit) may look like. */
function announcedSignOut(registry: unknown): SignOutOption | undefined {
  if (typeof registry !== 'object' || registry === null) return undefined;
  const account = (registry as { account?: unknown }).account;
  if (typeof account !== 'object' || account === null) return undefined;
  const signOut = (account as { signOut?: unknown }).signOut;
  if (typeof signOut === 'string') return signOut;
  if (typeof signOut === 'object' && signOut !== null) {
    const s = signOut as { action?: unknown; href?: unknown };
    if (typeof s.action === 'string') return { action: s.action };
    if (typeof s.href === 'string') return { href: s.href };
  }
  return undefined;
}

/**
 * The sign-out the footer offers: the host's `signOut` option when set (`false` = none), else the
 * one an account console (authkit) announced on the `agora.consoles` registry, else none. Only
 * same-origin paths are ever emitted. A POST action carries the request's CSRF token when there is
 * one.
 */
export function resolveSignOut(
  ctx: HttpContext,
  configured: SignOutOption | null | undefined,
  registry: unknown,
): ConsoleSignOut | undefined {
  if (configured === false) return undefined;
  const option = configured ?? announcedSignOut(registry);
  if (option === undefined || option === false) return undefined;
  if (typeof option === 'object' && 'href' in option) {
    return safePath(option.href) ? { href: option.href } : undefined;
  }
  const action = typeof option === 'string' ? option : option.action;
  if (!safePath(action)) return undefined;
  const csrfToken = csrfTokenOf(ctx);
  return { action, ...(csrfToken ? { csrfToken } : {}) };
}

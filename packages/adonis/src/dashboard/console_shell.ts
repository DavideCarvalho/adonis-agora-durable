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

/** The first role of a user, from `role`, `roles: string[]` or `roles: [{ name }]`. */
function roleOf(user: Record<string, unknown>): string | undefined {
  const direct = text(user.role);
  if (direct) return direct;
  const roles = user.roles;
  if (Array.isArray(roles)) {
    for (const role of roles) {
      const name =
        text(role) ??
        (typeof role === 'object' && role !== null
          ? text((role as { name?: unknown }).name)
          : undefined);
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * A viewer from any user-ish object: `fullName` / `name` / `email` for the label, `email`, and the
 * first of `role` / `roles`. `undefined` when nothing usable is there.
 */
export function viewerFromUser(user: unknown): ConsoleViewer | undefined {
  if (typeof user !== 'object' || user === null) return undefined;
  const u = user as Record<string, unknown>;
  const email = text(u.email);
  const label = text(u.fullName) ?? text(u.name) ?? email;
  if (!label) return undefined;
  const role = roleOf(u);
  return { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
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
 * already authenticated; it never triggers an authentication.
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
  try {
    const auth = (ctx as unknown as { auth?: { user?: unknown } }).auth;
    return viewerFromUser(auth?.user);
  } catch {
    // Some guards throw on `.user` before authentication; that just means "no viewer".
    return undefined;
  }
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

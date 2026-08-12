import {
  type DashboardSession,
  type DashboardSessionUser,
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';

/**
 * Framework-light `dashboardAuth` mechanism for the durable dashboard — config resolution, the
 * open-redirect guard, the login decision, and session verification. NO AdonisJS types leak in
 * (mirroring {@link file://./handlers.ts handlers.ts}), so every branch is unit-testable against a
 * plain object with no HTTP server. The provider (`providers/dashboard_provider.ts`) adapts an
 * `HttpContext` to these functions and owns the cookie read/write via AdonisJS's native cookie API.
 *
 * When configured it gates BOTH the dashboard HTML shell (a full-page navigation redirected `302`
 * to a server-rendered login page) and the JSON API (a plain `401`) behind a signed session cookie.
 * When left unconfigured the dashboard behaves exactly as before (no login/logout routes, no
 * session guard).
 */

/** Host hook validating submitted credentials from the built-in login page (Mode B — standalone). */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/**
 * Host hook validating the HOST APP's own auth off the raw request (Mode A — SSO / "open from your
 * app"). Receives the underlying platform request object (an AdonisJS `Request['request']`, i.e. the
 * raw Node `IncomingMessage`) rather than an AdonisJS type, so this module stays framework-light and
 * unit-testable with no `HttpContext` — the provider passes it through untouched. Mirrors the NestJS
 * sibling console's `SessionHook` byte-for-byte (same two-mode split).
 */
export type SessionHook = (
  request: unknown,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/**
 * Author-facing `dashboardAuth` option on `config/durable_dashboard.ts`. Gates the dashboard behind
 * a signed session cookie, minted by whichever mode(s) are configured:
 *
 * - Mode B (`login`) — the built-in server-rendered login page (`GET <path>/login`), for a
 *   standalone console with its own credentials.
 * - Mode A (`session`) — `POST <path>/session`, for a host app that's already authenticated the
 *   operator itself and wants a one-shot "open the console" button (see `client/console-session.ts`).
 *
 * Both may be configured together; at least one is required. The bundled dashboard SPA is unaware of
 * which mode(s) are active — it only reacts to a 401's `{ auth: { modes } }` body (see
 * `durable-client.ts`).
 *
 * Nest needed a `forRootAsync` to reach app services from these hooks; AdonisJS does not — the config
 * module is a plain file and each hook is just a function that may be `async` and close over
 * `app.container`/services (import them at the top of `config/durable_dashboard.ts`), so there is
 * nothing extra to build for the async case.
 */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key. Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL as a duration string (`'8h'`, `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /** Validates submitted username/password; return the session user, or `null` to deny. Thrown
   *  errors are treated as a denial (logged once, never surfaced to the client). May be async. */
  login?: LoginHook;
  /** Validates the host app's own auth off the raw request; return the session user, or `null` to
   *  deny. Thrown errors are treated as a denial. May be async. */
  session?: SessionHook;
}

/** Which auth surface(s) are active — carried on an API 401's `{ auth: { modes } }` body so the SPA
 *  knows whether to offer the login page or just report "not authenticated". */
export type AuthMode = 'session' | 'login';

/** Resolved, validated `dashboardAuth` config shared by the guard, the login/session handlers, and
 *  the page. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  login?: LoginHook;
  session?: SessionHook;
}

/** Cookie name carrying the signed dashboard session. */
export const SESSION_COOKIE_NAME = 'durable_dashboard_session';

const DEFAULT_TTL = '8h';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parse a `'<number><s|m|h|d>'` duration to ms; falls back to the 8h default on a bad value. */
function durationToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return DEFAULT_TTL_MS;
  const unit = DURATION_UNITS[match[2] ?? ''];
  if (unit === undefined) return DEFAULT_TTL_MS;
  return Number(match[1]) * unit;
}

/**
 * Validate + resolve the `dashboardAuth` option. Returns `null` when unconfigured (today's
 * unauthenticated behavior, unchanged). Throws at boot (fail closed) when configured but missing a
 * secret, or neither `login` nor `session` is a function — the host learns immediately rather than
 * shipping an un-mintable gate.
 */
export function resolveDashboardAuth(
  options: DashboardAuthOptions | undefined,
): ResolvedDashboardAuth | null {
  if (options === undefined) return null;
  if (typeof options.secret !== 'string' || options.secret === '') {
    throw new Error(
      'durable_dashboard: dashboardAuth.secret is required and must be a non-empty string ' +
        '(HMAC-SHA256 signing key, 32+ bytes recommended). Failing closed.',
    );
  }
  const hasLogin = typeof options.login === 'function';
  const hasSession = typeof options.session === 'function';
  if (!hasLogin && !hasSession) {
    throw new Error(
      'durable_dashboard: dashboardAuth needs at least one of `login` or `session` (a login hook or ' +
        'a host-session hook).',
    );
  }
  const modes: AuthMode[] = [];
  if (hasSession) modes.push('session');
  if (hasLogin) modes.push('login');
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl ?? DEFAULT_TTL),
    modes,
    ...(hasLogin ? { login: options.login } : {}),
    ...(hasSession ? { session: options.session } : {}),
  };
}

/**
 * Guard a client-supplied redirect target against an open redirect: it must be a same-origin,
 * root-relative path (`/durable/foo`), never a protocol-relative (`//evil.com`) or absolute
 * (`https://evil.com`) URL. Falls back to `fallback` (the dashboard's own `basePath`) for anything
 * else, including a missing/non-string value.
 */
export function sanitizeReturnTo(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string') return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.includes('://')) return fallback;
  return candidate;
}

/** The parsed login POST body. */
interface LoginBody {
  username?: unknown;
  password?: unknown;
  returnTo?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * The framework-light outcome of a login attempt, mapped to HTTP by the provider:
 * - `ok`       → set `cookieValue` as the session cookie, reply `200 { redirectTo }`.
 * - `bad-request` → `400` (body missing string `username`/`password`).
 * - `unauthorized` → uniform `401 { error }` for EVERY credential failure (unknown user, wrong
 *   password, or a throwing hook) — no user-enumeration. `hookError` is set only when the hook
 *   threw, so the provider can warn-log it once without changing the client-visible response.
 */
export type LoginOutcome =
  | { kind: 'ok'; cookieValue: string; redirectTo: string }
  | { kind: 'bad-request'; message: string }
  | { kind: 'unauthorized'; message: string; hookError?: unknown };

const UNAUTHORIZED_MESSAGE = 'Invalid username or password.';

/**
 * Run a host hook (`login` or `session`) defensively: a throw is treated as a denial (uniform
 * failure) so a buggy hook never 500s the endpoint into a stack-trace leak. The thrown error is
 * surfaced on the outcome (`hookError`) so the provider can warn-log it once, but it never reaches
 * the client.
 */
async function runHook(
  hook: () => Promise<DashboardSessionUser | null> | DashboardSessionUser | null,
): Promise<{ user: DashboardSessionUser | null; error?: unknown }> {
  try {
    return { user: (await hook()) ?? null };
  } catch (error) {
    return { user: null, error };
  }
}

/**
 * Decide a login attempt end-to-end (validate body → run hook → mint cookie) with no HTTP types.
 * On success returns the signed cookie value to set plus the sanitized `redirectTo`; the password
 * is forwarded to the hook AS-IS (empty string when blank), so the hook alone decides whether a
 * password is required. `404`-worthy (Mode B not configured) is the provider's call, not this
 * function's — it only runs once the provider has confirmed `auth.login` exists.
 */
export async function performLogin(
  auth: ResolvedDashboardAuth,
  body: unknown,
  basePath: string,
  now?: number,
): Promise<LoginOutcome> {
  const parsed = (body ?? {}) as LoginBody;
  if (!isString(parsed.username) || !isString(parsed.password)) {
    return { kind: 'bad-request', message: 'Body must include string `username` and `password`.' };
  }
  const login = auth.login;
  if (!login) {
    return { kind: 'unauthorized', message: UNAUTHORIZED_MESSAGE };
  }
  const { user, error } = await runHook(() =>
    login(parsed.username as string, parsed.password as string),
  );
  if (!user) {
    return error !== undefined
      ? { kind: 'unauthorized', message: UNAUTHORIZED_MESSAGE, hookError: error }
      : { kind: 'unauthorized', message: UNAUTHORIZED_MESSAGE };
  }
  const cookieValue = signSessionCookie(user, {
    secret: auth.secret,
    ttlMs: auth.ttlMs,
    ...(now !== undefined ? { now } : {}),
  });
  return { kind: 'ok', cookieValue, redirectTo: sanitizeReturnTo(parsed.returnTo, basePath) };
}

/**
 * The framework-light outcome of a Mode A session-mint attempt (`POST <path>/session`), mapped to
 * HTTP by the provider: `ok` → set the cookie, reply `204`; `unauthorized` → uniform `401` (the
 * `session` hook returned/threw a denial).
 */
export type SessionOutcome =
  | { kind: 'ok'; cookieValue: string }
  | { kind: 'unauthorized'; hookError?: unknown };

/**
 * Decide a Mode A session-mint attempt end-to-end: run the host's `session` hook against the raw
 * platform request, and mint the cookie on success. No body to validate — the hook reads whatever it
 * needs directly off `request` (its own cookie/JWT/header).
 */
export async function performSession(
  auth: ResolvedDashboardAuth,
  request: unknown,
  now?: number,
): Promise<SessionOutcome> {
  const session = auth.session;
  if (!session) return { kind: 'unauthorized' };
  const { user, error } = await runHook(() => session(request));
  if (!user) {
    return error !== undefined
      ? { kind: 'unauthorized', hookError: error }
      : { kind: 'unauthorized' };
  }
  const cookieValue = signSessionCookie(user, {
    secret: auth.secret,
    ttlMs: auth.ttlMs,
    ...(now !== undefined ? { now } : {}),
  });
  return { kind: 'ok', cookieValue };
}

/**
 * Read + verify a session cookie value, returning the session or `null` when absent, tampered, or
 * expired. Thin wrapper over {@link verifySessionCookie} so the provider never touches crypto.
 */
export function readSession(
  auth: ResolvedDashboardAuth,
  cookieValue: string | undefined,
  now?: number,
): DashboardSession | null {
  if (cookieValue === undefined || cookieValue === '') return null;
  return verifySessionCookie(cookieValue, {
    secret: auth.secret,
    ...(now !== undefined ? { now } : {}),
  });
}

export type { DashboardSession, DashboardSessionUser } from './session_cookie.js';

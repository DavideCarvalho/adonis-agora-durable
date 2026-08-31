import { timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import {
  type DashboardAuthOptions,
  type ResolvedDashboardAuth,
  resolveDashboardAuth,
} from './auth.js';

/**
 * The function form of {@link DurableDashboardConfig.accessDenied}: render (or answer) a refused
 * page navigation yourself. Receives the refusal ({@link AccessDeniedInfo}) and the AdonisJS
 * {@link HttpContext}. Return an HTML string to have it served; answer the request yourself (a
 * redirect, most commonly) and return nothing to make the provider stand down; return nothing
 * WITHOUT answering and the built-in page is served.
 */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<HttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<HttpContext>;

/**
 * Authorization guard for the dashboard. Runs before every dashboard route
 * (API + HTML). Return `true` to allow the request, `false` to deny it (the
 * provider replies `403`). May be async (e.g. an auth lookup).
 *
 * It receives the AdonisJS {@link HttpContext}, so it can read the session,
 * a bearer token, an IP allow-list, etc.
 */
export type AuthorizeHook = (ctx: HttpContext) => boolean | Promise<boolean>;

/** Shape of `config/durable_dashboard.ts`. */
export interface DurableDashboardConfig {
  /**
   * Master switch. When `false`, the provider registers no routes at all — the
   * dashboard is completely absent. Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * URL prefix the dashboard + its API mount under. Defaults to `/durable`.
   * The HTML is served at the prefix root; the JSON API lives under
   * `<path>/api`.
   */
  path?: string;
  /**
   * Per-request authorization guard. Defaults to {@link defaultAuthorize}:
   * allow everything OUTSIDE production, and in production require a bearer
   * token matching the `DURABLE_DASHBOARD_TOKEN` env var (deny if it is unset).
   */
  authorize?: AuthorizeHook;
  /**
   * Optional built-in login screen. When set, the provider mounts a
   * server-rendered `GET <path>/login` page plus `POST <path>/login` /
   * `GET <path>/logout`, and stamps a session guard on the dashboard: an
   * unauthenticated page navigation is redirected (`302`) to the login page and
   * an unauthenticated API request gets `401`. The signed session cookie is
   * minted only by the host's {@link DashboardAuthOptions.login} hook.
   *
   * This is ADDITIVE and composes WITH {@link authorize} (both must pass) — it
   * does not replace it. Omit it entirely to keep today's behavior byte-for-byte
   * (no login/logout routes, no session guard). Missing `secret`/`login` fails
   * closed at boot.
   */
  dashboardAuth?: DashboardAuthOptions;
  /**
   * What a BROWSER sees when the guard refuses a page navigation (the SPA shell, its assets, or —
   * Mode A only — a session-less visit). API requests are unaffected:
   * they keep getting the JSON the SPA relies on (`403 { error: 'forbidden' }` /
   * `401 { error: 'unauthorized', auth }`).
   *
   * Omit it for the built-in page — a dark card in the console's own visual language, with the
   * status, a sentence explaining the refusal, a "Back to app" link and, when `dashboardAuth.login`
   * exists, a "Sign in" button. Pass an object to tweak that page (`brand`, `title`, `message`,
   * `homeHref`, `loginHref`, `accent`, …), or a function to render/answer it yourself — see
   * {@link AccessDeniedRenderer}. Either way, an `authorize` hook that already wrote a redirect
   * still wins: the provider never overwrites a `location` header.
   */
  accessDenied?: AccessDeniedOption;
}

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedDurableDashboardConfig {
  enabled: boolean;
  path: string;
  authorize: AuthorizeHook;
  /** Resolved built-in login config, or `null` when `dashboardAuth` is unconfigured. */
  dashboardAuth: ResolvedDashboardAuth | null;
  /** The host's `accessDenied` option as given, or `null` for the built-in page with defaults. */
  accessDenied: AccessDeniedOption | null;
}

/**
 * Whether the process is running in production. Mirrors how AdonisJS reads the
 * environment without taking a hard dependency on its env service.
 */
function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Extract a bearer token from an `Authorization: Bearer <token>` header, a
 * `token` query-string param, or an `x-durable-token` header — whichever is
 * present. Returns `undefined` when none is supplied.
 */
function readToken(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match?.[1]) return match[1].trim();
  }
  const xHeader = ctx.request.header('x-durable-token');
  if (xHeader) return xHeader.trim();
  const qs = ctx.request.qs().token;
  if (typeof qs === 'string' && qs.length > 0) return qs;
  return undefined;
}

/**
 * Compare two secrets in constant time (guarding for equal byte-length first,
 * since {@link timingSafeEqual} throws on a length mismatch). Returns `false`
 * for any length difference, otherwise the timing-safe equality — so the token
 * check leaks neither a match nor the token's length via response time.
 */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The default guard: open outside production; in production it requires a
 * bearer token equal to `DURABLE_DASHBOARD_TOKEN`. If that env var is unset in
 * production the dashboard is denied entirely (fail-closed) — you must opt in
 * by setting a token or supplying your own {@link AuthorizeHook}.
 */
export function defaultAuthorize(ctx: HttpContext): boolean {
  if (!isProduction()) return true;
  const expected = process.env.DURABLE_DASHBOARD_TOKEN;
  if (!expected) return false;
  const provided = readToken(ctx);
  if (provided === undefined) return false;
  // Constant-time compare to remove the timing side-channel from the token check.
  return secretsMatch(provided, expected);
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(config: DurableDashboardConfig = {}): ResolvedDurableDashboardConfig {
  const rawPath = config.path ?? '/durable';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '/').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    authorize: config.authorize ?? defaultAuthorize,
    // Validate + resolve now so a misconfigured secret/login fails closed at boot,
    // not on the first login attempt. `null` when `dashboardAuth` is omitted.
    dashboardAuth: resolveDashboardAuth(config.dashboardAuth),
    accessDenied: config.accessDenied ?? null,
  };
}

/** Identity helper giving `config/durable_dashboard.ts` full type-checking. */
export function defineConfig(config: DurableDashboardConfig = {}): DurableDashboardConfig {
  return config;
}

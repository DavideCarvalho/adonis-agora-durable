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
   * Per-request authorization guard. Defaults to {@link defaultAuthorize}, which FAILS CLOSED in
   * EVERY environment: it requires a bearer token matching `DURABLE_DASHBOARD_TOKEN` (denying
   * everything when that env var is unset) — unless {@link dashboardAuth} is configured (the
   * session guard is then the gate) or {@link allowUnauthenticated} explicitly opts out.
   *
   * (Before 0.37 the default was open outside `NODE_ENV=production` — which left every dev/staging
   * deployment, and any box where NODE_ENV was unset or spelled differently, with an unauthenticated
   * console whose destructive endpoints a malicious web page could drive via cross-site POSTs.)
   */
  authorize?: AuthorizeHook;
  /**
   * Explicitly serve the dashboard WITHOUT any authentication. This is the loaded footgun the old
   * "open outside production" default was — now it at least has to be spelled out in config, so a
   * deploy can grep for it. Only for local development / networks you fully trust. Ignored when
   * `authorize` or `dashboardAuth` is configured.
   */
  allowUnauthenticated?: boolean;
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
   * Audit sink for MUTATING console actions (retry, cancel, bulk, fix-and-replay, signal, update,
   * task completion, schedule control): called once per attempt with who did what, before the
   * handler runs. Omit for the default — a structured line on the app logger. The old console had
   * NO actor attribution at all; an operator bulk-cancelling 500 runs left no trace of who asked.
   */
  audit?: (entry: DashboardAuditEntry) => void;
  /**
   * Redact what the console SHOWS: hooks over the serialized run / checkpoint shapes, applied to
   * every list/detail response right before it leaves the API. The store may hold payloads
   * encrypted (CodecStateStore), but the dashboard reads through the codec and always rendered them
   * DECODED — this is the knob that keeps a card number or PII out of the operator's browser:
   * `{ run: (r) => ({ ...r, input: undefined }), checkpoint: (c) => ({ ...c, output: '[redacted]' }) }`.
   */
  redact?: {
    run?: (run: Record<string, unknown>) => Record<string, unknown>;
    checkpoint?: (checkpoint: Record<string, unknown>) => Record<string, unknown>;
  };
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
  /** The host's audit sink, or `null` for the default logger line. */
  audit: ((entry: DashboardAuditEntry) => void) | null;
  /** The host's redaction hooks, or `null` to serve shapes as-is. */
  redact: {
    run?: (run: Record<string, unknown>) => Record<string, unknown>;
    checkpoint?: (checkpoint: Record<string, unknown>) => Record<string, unknown>;
  } | null;
}

/** One audited mutating console action — who (actor), what (method + path), when. */
export interface DashboardAuditEntry {
  at: Date;
  /** The session user's name/id, `'token'` for a bearer-token caller, else `'anonymous'`. */
  actor: string;
  method: string;
  /** The request path (no query string — a `?token=` must never reach an audit log). */
  path: string;
}

/**
 * Whether the process is running in production. Mirrors how AdonisJS reads the
 * environment without taking a hard dependency on its env service. No longer an
 * AUTH decision input (the guard fails closed everywhere) — used only for
 * cookie hardening defaults.
 */
export function isProduction(): boolean {
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
  // The query-string channel exists ONLY because EventSource (the SSE live-tail) cannot set
  // headers. Restricted to read methods: a `?token=` that authorized POSTs turned any leaked/logged
  // URL (access logs, Referer, browser history) into a destructive-capable magic link.
  const method = ctx.request.method().toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    const qs = ctx.request.qs().token;
    if (typeof qs === 'string' && qs.length > 0) return qs;
  }
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
 * The default guard: FAIL CLOSED in every environment — require a bearer token equal to
 * `DURABLE_DASHBOARD_TOKEN`, denying everything when that env var is unset. There is no
 * NODE_ENV branch anymore: "not production" is exactly the set of deployments (dev boxes,
 * staging, misspelled envs) that used to ship an open console. Opt out explicitly with
 * `allowUnauthenticated: true`, or configure `dashboardAuth`/your own `authorize`.
 */
export function defaultAuthorize(ctx: HttpContext): boolean {
  const expected = process.env.DURABLE_DASHBOARD_TOKEN;
  if (!expected) return false;
  const provided = readToken(ctx);
  if (provided === undefined) return false;
  // Constant-time compare to remove the timing side-channel from the token check.
  return secretsMatch(provided, expected);
}

/** The explicit `allowUnauthenticated: true` guard — allow everything, by conscious opt-in only. */
const allowAll: AuthorizeHook = () => true;

let warnedOpenDashboard = false;

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(config: DurableDashboardConfig = {}): ResolvedDurableDashboardConfig {
  const rawPath = config.path ?? '/durable';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '/').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  // Default guard resolution, in order:
  //  1. a host `authorize` hook wins;
  //  2. `dashboardAuth` configured -> the session guard IS the gate (the default token guard would
  //     otherwise 403 every login flow that never set DURABLE_DASHBOARD_TOKEN);
  //  3. `allowUnauthenticated: true` -> consciously open (warned once at resolve time);
  //  4. else the fail-closed token guard.
  const hasDashboardAuth = config.dashboardAuth !== undefined;
  let authorize: AuthorizeHook;
  if (config.authorize) {
    authorize = config.authorize;
  } else if (hasDashboardAuth) {
    authorize = allowAll;
  } else if (config.allowUnauthenticated === true) {
    if (!warnedOpenDashboard) {
      warnedOpenDashboard = true;
      console.warn(
        '[durable_dashboard] allowUnauthenticated: true — the console (including destructive ' +
          'endpoints) is served with NO authentication. Never ship this to a reachable network.',
      );
    }
    authorize = allowAll;
  } else {
    authorize = defaultAuthorize;
  }
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    authorize,
    // Validate + resolve now so a misconfigured secret/login fails closed at boot,
    // not on the first login attempt. `null` when `dashboardAuth` is omitted.
    dashboardAuth: resolveDashboardAuth(config.dashboardAuth),
    accessDenied: config.accessDenied ?? null,
    audit: config.audit ?? null,
    redact: config.redact ?? null,
  };
}

/** Identity helper giving `config/durable_dashboard.ts` full type-checking. */
export function defineConfig(config: DurableDashboardConfig = {}): DurableDashboardConfig {
  return config;
}

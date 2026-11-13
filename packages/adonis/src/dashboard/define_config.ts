import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizeGate,
  type ConsoleAuthorizeResult,
  type ConsoleDecision,
  normalizeConsoleDecision,
  resolveConsoleAuthorize,
} from './console_authorize.js';
import type { ConsoleViewer, SignOutOption, ViewerHook } from './console_shell.js';

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
 * A structured answer from an {@link AuthorizeHook}: whether the request may proceed and, when it may
 * not, why. The `reason` picks the status: `'unauthenticated'` (nobody is signed in) → `401`,
 * `'forbidden'` (signed in, not allowed) → `403`. No reason → `403` (fail closed).
 */
export interface AuthorizeDecision {
  allowed: boolean;
  reason?: 'unauthenticated' | 'forbidden';
}

/**
 * What an {@link AuthorizeHook} may return: the shared {@link ConsoleAuthorizeResult} (a boolean,
 * a decision, or `{ redirectTo }`) or an {@link AuthorizeDecision}.
 */
export type AuthorizeResult = ConsoleAuthorizeResult | AuthorizeDecision;

/**
 * The function form of `authorize`. It receives the AdonisJS {@link HttpContext}, so it can read the
 * session, a bearer token, an IP allow-list, etc. May be async.
 */
export type AuthorizeHook = (ctx: HttpContext) => AuthorizeResult | Promise<AuthorizeResult>;

/**
 * Collapse an {@link AuthorizeResult} into a decision. Only `true` or an object with
 * `allowed === true` allows; `{ redirectTo }` is an unauthenticated denial carrying the redirect
 * target; anything else — `false`, `{ allowed: false }`, a truthy non-boolean, a missing value —
 * denies with `403`.
 */
export function normalizeAuthorizeResult(result: unknown): ConsoleDecision {
  return normalizeConsoleDecision(result);
}

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
   * Who may reach the console. Runs before every dashboard route (API + HTML). Takes the shared
   * {@link ConsoleAuthorize} contract — an inline function, an authorizer class (resolved through the
   * container, so `@inject()` works), or a lazy import of one (`() => import('#policies/console_access')`).
   * It returns a boolean, `{ allowed, reason? }` (`reason: 'unauthenticated'` → `401`, any other
   * denial `403`) or `{ redirectTo }` (`302` for a page, `401` for an API call). A throw is a `403`.
   *
   * Omitted, the console is open when the app is not in production and answers `403` to every
   * request in production (a warning is logged once at boot). For machine access use
   * `authorizeByToken({ token })`.
   */
  authorize?: ConsoleAuthorize | AuthorizeHook;
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
   * nothing else). API requests are unaffected:
   * they keep getting the JSON the SPA relies on (`403 { error: 'forbidden' }` /
   * `401 { error: 'unauthenticated' }`).
   *
   * Omit it for the built-in page — a dark card in the console's own visual language, with the
   * status, a sentence explaining the refusal and a "Back to app" link. Pass an object to tweak that page (`brand`, `title`, `message`,
   * `homeHref`, `loginHref`, `accent`, …), or a function to render/answer it yourself — see
   * {@link AccessDeniedRenderer}. Either way, an `authorize` hook that already wrote a redirect
   * still wins: the provider never overwrites a `location` header.
   */
  accessDenied?: AccessDeniedOption;
  /**
   * Who the console's sidebar footer shows as signed in. Omit it to read `ctx.auth.user`
   * structurally (`fullName`/`name`/`email`, first of `role`/`roles`) when the request is already
   * authenticated; return `null` for no user row. A throw is treated as `null`.
   */
  viewer?: ViewerHook;
  /**
   * The footer's "Sign out": a POST action path (`'/logout'`, sent with the CSRF token), `{ href }`
   * for a plain link, or `false` for none. Omit it to use the sign-out an account console (authkit)
   * announces on the `agora.consoles` registry, when there is one. Same-origin paths only.
   */
  signOut?: SignOutOption;
}

export type { ConsoleViewer, SignOutOption, ViewerHook };

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedDurableDashboardConfig {
  enabled: boolean;
  path: string;
  /** The resolved `authorize` gate (or the default): one call per request, never throws. */
  authorize: ConsoleAuthorizeGate;
  /** Whether the host set `authorize` (`false` means the dev-open / production-deny default). */
  authorizeConfigured: boolean;
  /** The host's `accessDenied` option as given, or `null` for the built-in page with defaults. */
  accessDenied: AccessDeniedOption | null;
  /** The host's audit sink, or `null` for the default logger line. */
  audit: ((entry: DashboardAuditEntry) => void) | null;
  /** The host's redaction hooks, or `null` to serve shapes as-is. */
  redact: {
    run?: (run: Record<string, unknown>) => Record<string, unknown>;
    checkpoint?: (checkpoint: Record<string, unknown>) => Record<string, unknown>;
  } | null;
  /** The host's `viewer` hook, or `null` for the structural `ctx.auth.user` read. */
  viewer: ViewerHook | null;
  /** The host's `signOut` option, or `null` for the registry's announced one. */
  signOut: SignOutOption | null;
}

/** One audited mutating console action — who (actor), what (method + path), when. */
export interface DashboardAuditEntry {
  at: Date;
  /**
   * The signed-in user (`ctx.auth.user`'s `email`, `name` or `id`), `'bearer'` for a caller with an
   * `Authorization` header and no user, else `'anonymous'`. An action run from a developer tool
   * over MCP is `'mcp:<caller>'` (`mcp:token:3f9a1c2b7d10`, `mcp:user:42`).
   */
  actor: string;
  /** The HTTP method, or `'MCP'` for a developer tool. */
  method: string;
  /** The request path (no query string), or `'<tool> <run id or schedule key>'` for a developer tool. */
  path: string;
}

/** The warning logged once at boot when `authorize` is omitted. */
export const NO_AUTHORIZE_WARNING =
  '[@adonis-agora/durable] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/durable_dashboard.ts.';

const allowAll: ConsoleAuthorizeGate = async () => ({ allowed: true });
const denyAll: ConsoleAuthorizeGate = async () => ({ allowed: false, reason: 'forbidden' });

/** Options for {@link resolveConfig}. */
export interface ResolveConfigOptions {
  /**
   * Whether the app runs in production (`app.inProduction`). Only `false` opens a console without
   * `authorize`; anything else denies it.
   */
  inProduction?: boolean;
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(
  config: DurableDashboardConfig = {},
  options: ResolveConfigOptions = {},
): ResolvedDurableDashboardConfig {
  const rawPath = config.path ?? '/durable';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '/').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const authorizeConfigured = config.authorize !== undefined;
  let authorize: ConsoleAuthorizeGate;
  if (config.authorize !== undefined) authorize = resolveConsoleAuthorize(config.authorize);
  else authorize = options.inProduction === false ? allowAll : denyAll;
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    authorize,
    authorizeConfigured,
    accessDenied: config.accessDenied ?? null,
    audit: config.audit ?? null,
    redact: config.redact ?? null,
    viewer: config.viewer ?? null,
    signOut: config.signOut ?? null,
  };
}

/** Identity helper giving `config/durable_dashboard.ts` full type-checking. */
export function defineConfig(config: DurableDashboardConfig = {}): DurableDashboardConfig {
  return config;
}

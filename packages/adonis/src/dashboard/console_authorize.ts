import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a console `authorize` returns. The same shape every `@adonis-agora` console accepts:
 *
 * - `true` / `{ allowed: true }` → the request proceeds;
 * - `false` / `{ allowed: false }` / `{ allowed: false, reason: 'forbidden' }` → `403`;
 * - `{ allowed: false, reason: 'unauthenticated' }` → `401`;
 * - `{ redirectTo: '/login' }` → `302` to that path for a page navigation, `401` JSON for an API call.
 */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a class with typed constructor params (`@inject()`) is not assignable to `unknown[]`.
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/**
 * The console `authorize` option, in three forms: an inline function, an authorizer class, or a
 * lazy import of a module whose default export is an authorizer class.
 */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** A normalized console decision. A denial always carries a reason (`401` vs `403`). */
export type ConsoleDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      /** Set when `authorize` asked for a redirect: page navigations go there (`302`). */
      redirectTo?: string;
      /** Set when `authorize` threw: the denial is a `403`, the error is for logging only. */
      error?: unknown;
    };

/** A resolved `authorize`: one call per request, never throws. */
export type ConsoleAuthorizeGate = (ctx: HttpContext) => Promise<ConsoleDecision>;

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function lazyModuleClass(value: unknown): ConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { default?: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

/**
 * Collapse an `authorize` result into a {@link ConsoleDecision}. Only `true` or an object with
 * `allowed === true` allows; `{ redirectTo }` is an unauthenticated denial with a redirect target;
 * anything else — `false`, `{ allowed: false }`, a truthy non-boolean, a missing value — is a `403`.
 */
export function normalizeConsoleDecision(result: unknown): ConsoleDecision {
  if (result === true) return { allowed: true };
  if (typeof result !== 'object' || result === null) return { allowed: false, reason: 'forbidden' };
  const record = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
  if (record.allowed === true) return { allowed: true };
  if (typeof record.redirectTo === 'string' && record.redirectTo !== '') {
    return { allowed: false, reason: 'unauthenticated', redirectTo: record.redirectTo };
  }
  return {
    allowed: false,
    reason: record.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden',
  };
}

async function runAuthorizer(
  Authorizer: ConsoleAuthorizerClass,
  ctx: HttpContext,
): Promise<unknown> {
  const instance = await ctx.containerResolver.make(Authorizer);
  return instance.authorize(ctx);
}

/**
 * Turn any {@link ConsoleAuthorize} form into a per-request gate:
 *
 * - a class is instantiated through the request's container resolver (so `@inject()` works) and its
 *   `authorize(ctx)` is called;
 * - a function is called with `ctx`; when it resolves to a module whose `default` is an authorizer
 *   class it was a lazy import — the class is remembered (the import runs once) and used from then on;
 * - a thrown error is a `403`, never an allow.
 */
export function resolveConsoleAuthorize(authorize: unknown): ConsoleAuthorizeGate {
  let Authorizer: ConsoleAuthorizerClass | undefined = isAuthorizerClass(authorize)
    ? authorize
    : undefined;
  if (Authorizer === undefined && typeof authorize !== 'function') {
    throw new TypeError(
      '[console] `authorize` must be a function, an authorizer class, or a lazy import of one.',
    );
  }
  const fn = authorize as (ctx: HttpContext) => unknown;

  return async (ctx) => {
    try {
      if (Authorizer !== undefined) {
        return normalizeConsoleDecision(await runAuthorizer(Authorizer, ctx));
      }
      const result = await fn(ctx);
      const lazy = lazyModuleClass(result);
      if (lazy !== undefined) {
        Authorizer = lazy;
        return normalizeConsoleDecision(await runAuthorizer(lazy, ctx));
      }
      return normalizeConsoleDecision(result);
    } catch (error) {
      return { allowed: false, reason: 'forbidden', error };
    }
  };
}

/** Options for {@link authorizeByToken}. */
export interface AuthorizeByTokenOptions {
  /** The shared secret callers send as `Authorization: Bearer <token>`. */
  token: string | undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * An `authorize` for machine access (scripts, a Prometheus scrape): allows a request whose
 * `Authorization` header is `Bearer <token>`, and answers `{ allowed: false, reason: 'unauthenticated' }`
 * (`401`) otherwise. Only the header is read.
 *
 * ```ts
 * authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 * ```
 *
 * Throws at config time when `token` is empty or undefined.
 */
export function authorizeByToken(
  options: AuthorizeByTokenOptions,
): (ctx: HttpContext) => ConsoleAuthorizeResult {
  const token = options?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('authorizeByToken: `token` must be a non-empty string');
  }
  // Compare digests: equal length always, so the check leaks neither a match nor the token length.
  const expected = digest(token);
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(digest(match[1]), expected)) return { allowed: true };
    return { allowed: false, reason: 'unauthenticated' };
  };
}

/**
 * An `authorize` that allows a request when ANY of `authorizers` allows it, tried in order — e.g. a
 * machine token for MCP clients OR a signed-in admin for the browser:
 *
 * ```ts
 * authorize: anyAuthorize(
 *   authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 *   (ctx) => ctx.auth.user?.isAdmin === true,
 * ),
 * ```
 *
 * When none allows: `401` if any of them said "unauthenticated" (redirecting when one asked to),
 * `403` otherwise. A throwing authorizer counts as a `403` and the next one is still tried.
 */
export function anyAuthorize(
  ...authorizers: ConsoleAuthorize[]
): (ctx: HttpContext) => Promise<ConsoleAuthorizeResult> {
  if (authorizers.length === 0) {
    throw new Error('anyAuthorize: pass at least one authorize');
  }
  const resolved = authorizers.map((authorize) => resolveConsoleAuthorize(authorize));
  return async (ctx: HttpContext): Promise<ConsoleAuthorizeResult> => {
    let unauthenticated = false;
    let redirectTo: string | undefined;
    for (const authorize of resolved) {
      const decision = await authorize(ctx);
      if (decision.allowed) return { allowed: true };
      if (decision.reason !== 'unauthenticated') continue;
      if (decision.redirectTo !== undefined && redirectTo === undefined) {
        redirectTo = decision.redirectTo;
      }
      unauthenticated = true;
    }
    if (redirectTo !== undefined) return { redirectTo };
    return unauthenticated
      ? { allowed: false, reason: 'unauthenticated' }
      : { allowed: false, reason: 'forbidden' };
  };
}

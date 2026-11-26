import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * The console access contract every `@adonis-agora` console (config, crypto, durable, telescope,
 * media, payments, flags, agent, diagnostics, the authkit admin) takes for its `authorize` option.
 * This file is copied, not shared through a package, and kept byte-identical across the libs apart
 * from {@link PACKAGE}: TypeScript is structural, so one authorizer class satisfies every console.
 */

/** The only line that differs between the libs' copies. */
const PACKAGE = '@adonis-agora/durable';

/** `'read'`: the viewer may look, never change (no write capability reaches a command). */
export type ConsoleAccess = 'read' | 'write';

/** What an authorizer may answer. */
export type ConsoleAuthorizeResult =
  | boolean
  | {
      allowed: true;
      /**
       * The apps (tenant partitions) this viewer may see and change. `'*'` (or omitted) is every
       * app `console.apps` allows.
       */
      apps?: '*' | string[];
      /** The tenants this viewer may see, for consoles that scope by tenant. `'*'`: all. */
      tenants?: '*' | string[];
      /**
       * What this viewer may do, in the capability vocabulary (`<lib>:console:read`,
       * `<lib>:console:write`, `<lib>:console:*`, or the lib's finer names). Sent with every command
       * to another app, which checks it again. Omitted: the lib's full console set. Anything but a
       * list of strings allows nothing.
       */
      capabilities?: string[];
      /** `'read'`: sugar for "no write capabilities", whatever `capabilities` says. */
      access?: ConsoleAccess;
    }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: the constructor takes whatever the container injects.
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/** The `authorize` option: an inline function, the authorizer class, or a lazy import of it. */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** A {@link ConsoleAuthorizeResult} normalized to the answer the console writes. */
export type ConsoleAuthorizeDecision =
  | {
      allowed: true;
      apps?: '*' | string[];
      tenants?: '*' | string[];
      capabilities?: string[];
      access?: ConsoleAccess;
    }
  | { allowed: false; status: 401; reason: 'unauthenticated' }
  | { allowed: false; status: 403; reason: 'forbidden'; error?: unknown }
  | { allowed: false; status: 302; redirectTo: string };

const FORBIDDEN = { allowed: false, status: 403, reason: 'forbidden' } as const;

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

/** A module namespace whose `default` export is an authorizer class: a lazy import resolved. */
function lazyModuleClass(value: unknown): ConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null || !('default' in value)) return undefined;
  const candidate = (value as { default: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

/** `'*'`, or the names a list holds; anything else narrows to none (never wider). */
function names(value: unknown): '*' | string[] {
  if (value === '*') return '*';
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((a) => typeof a === 'string' || typeof a === 'number')
        .map(String)
        .filter((a) => a !== ''),
    ),
  ];
}

/**
 * Normalize an authorizer's answer. Fails closed: only `true` or `{ allowed: true }` passes. Its
 * `apps` / `tenants`, when not `'*'`, are kept as lists of names (a malformed one allows none);
 * `capabilities`, when present, as a list of non-empty strings (a malformed one allows nothing);
 * `access` only as `'read'` or `'write'`. `{ redirectTo }` with a non-empty string is a redirect;
 * anything else is a denial (`401` for `reason: 'unauthenticated'`, `403` otherwise).
 */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  if (result === true) return { allowed: true };
  if (typeof result !== 'object' || result === null) return FORBIDDEN;
  const value = result as {
    allowed?: unknown;
    reason?: unknown;
    redirectTo?: unknown;
    apps?: unknown;
    tenants?: unknown;
    capabilities?: unknown;
    access?: unknown;
  };
  if (value.allowed === true) {
    return {
      allowed: true,
      ...(value.apps !== undefined ? { apps: names(value.apps) } : {}),
      ...(value.tenants !== undefined ? { tenants: names(value.tenants) } : {}),
      ...(value.capabilities !== undefined
        ? {
            capabilities: Array.isArray(value.capabilities)
              ? value.capabilities.filter((c): c is string => typeof c === 'string' && c !== '')
              : [],
          }
        : {}),
      ...(value.access === 'read' || value.access === 'write' ? { access: value.access } : {}),
    };
  }
  if (value.allowed === undefined && typeof value.redirectTo === 'string' && value.redirectTo) {
    return { allowed: false, status: 302, redirectTo: value.redirectTo };
  }
  if (value.reason === 'unauthenticated') {
    return { allowed: false, status: 401, reason: 'unauthenticated' };
  }
  return FORBIDDEN;
}

async function instantiate(
  Authorizer: ConsoleAuthorizerClass,
  ctx: HttpContext,
): Promise<ConsoleAuthorizer> {
  const resolver = (ctx as { containerResolver?: { make?: unknown } }).containerResolver;
  if (resolver && typeof resolver.make === 'function') {
    return (await (resolver.make as (c: ConsoleAuthorizerClass) => unknown)(
      Authorizer,
    )) as ConsoleAuthorizer;
  }
  return new Authorizer();
}

/**
 * Turn an `authorize` option into one guard function.
 *
 * - A class is built through the request's container (`ctx.containerResolver.make`), so
 *   `@inject()` works, and its `authorize(ctx)` is called.
 * - A function is called with `ctx`. When it resolves to a module whose `default` is an
 *   authorizer class, it was a lazy import: the class is remembered (the import runs once per
 *   returned guard) and used as above.
 * - A thrown error is a `403` denial, carried on `error` so the caller can log it.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
): (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> {
  let lazyClass: ConsoleAuthorizerClass | undefined;

  const run = async (ctx: HttpContext): Promise<unknown> => {
    if (lazyClass) return (await instantiate(lazyClass, ctx)).authorize(ctx);
    if (isAuthorizerClass(authorize)) return (await instantiate(authorize, ctx)).authorize(ctx);
    const result = await (authorize as (ctx: HttpContext) => unknown)(ctx);
    const imported = lazyModuleClass(result);
    if (imported) {
      lazyClass = imported;
      return (await instantiate(imported, ctx)).authorize(ctx);
    }
    return result;
  };

  return async (ctx) => {
    try {
      return normalizeConsoleAuthorizeResult(await run(ctx));
    } catch (error) {
      return { ...FORBIDDEN, error };
    }
  };
}

/** Options for {@link authorizeByToken}. */
export interface AuthorizeByTokenOptions {
  /** The shared secret callers send as `Authorization: Bearer <token>`. */
  token: string | undefined;
  /** What a caller with the token may see and do: the same fields as an `authorize` answer. */
  apps?: '*' | string[];
  tenants?: '*' | string[];
  capabilities?: string[];
  access?: ConsoleAccess;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * An `authorize` check for machine access: allows a request whose `Authorization` header is
 * `Bearer <token>` (compared in constant time), and answers
 * `{ allowed: false, reason: 'unauthenticated' }` (`401`) otherwise. Only the header is read.
 *
 * ```ts
 * authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 * // narrowed: authorizeByToken({ token, apps: ['shop'], access: 'read' })
 * ```
 *
 * Throws at config time when `token` is empty or undefined.
 */
export function authorizeByToken(options: AuthorizeByTokenOptions): ConsoleAuthorize {
  const token = options?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error(`[${PACKAGE}] authorizeByToken: \`token\` must be a non-empty string`);
  }
  const expected = digest(token);
  // Normalized once, with the same fail-closed rules as any answer (a malformed list allows none).
  const { allowed: _allowed, ...grant } = normalizeConsoleAuthorizeResult({
    allowed: true,
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
    ...(options.tenants !== undefined ? { tenants: options.tenants } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.access !== undefined ? { access: options.access } : {}),
  }) as Extract<ConsoleAuthorizeDecision, { allowed: true }>;
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(digest(match[1]), expected)) {
      return { allowed: true, ...grant };
    }
    return { allowed: false, reason: 'unauthenticated' };
  };
}

/**
 * Allows a request when ANY of the given checks allows it, tried in order. Typical: a token for MCP
 * clients and scripts, or a signed-in admin for the browser.
 *
 * ```ts
 * authorize: anyAuthorize(
 *   authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 *   (ctx) => ctx.auth.user?.isAdmin ?? false,
 * ),
 * ```
 *
 * Refused by all: a redirect when one asked for it, else `401` when one wanted a sign-in, else `403`.
 */
export function anyAuthorize(
  ...authorizers: ConsoleAuthorize[]
): (ctx: HttpContext) => Promise<ConsoleAuthorizeResult> {
  if (authorizers.length === 0) {
    throw new Error(`[${PACKAGE}] anyAuthorize: pass at least one authorize`);
  }
  const resolved = authorizers.map((authorize) => resolveConsoleAuthorize(authorize));
  return async (ctx: HttpContext): Promise<ConsoleAuthorizeResult> => {
    let unauthenticated = false;
    let redirectTo: string | undefined;
    let error: unknown;
    let threw = false;
    for (const authorize of resolved) {
      const decision = await authorize(ctx);
      if (decision.allowed) {
        // The deciding authorizer's grant, whole: apps, tenants, capabilities and access.
        const { allowed: _allowed, ...grant } = decision;
        return { allowed: true, ...grant };
      }
      if (decision.status === 302) {
        redirectTo ??= decision.redirectTo;
        continue;
      }
      if (decision.status === 401) {
        unauthenticated = true;
        continue;
      }
      if (decision.error !== undefined && !threw) {
        threw = true;
        error = decision.error;
      }
    }
    if (redirectTo !== undefined) return { redirectTo };
    if (unauthenticated) return { allowed: false, reason: 'unauthenticated' };
    // Rethrow an inner check's error so the console still logs it (a throw is a 403).
    if (threw) throw error;
    return { allowed: false, reason: 'forbidden' };
  };
}

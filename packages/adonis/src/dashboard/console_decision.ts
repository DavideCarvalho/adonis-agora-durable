import type { HttpContext } from '@adonisjs/core/http';
import {
  type ConsoleAccess,
  type ConsoleAuthorize,
  type ConsoleAuthorizeDecision,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console_authorize.js';

/**
 * The durable console's view of an `authorize` answer: the shared contract's
 * {@link ConsoleAuthorizeDecision} (in `console_authorize.ts`, identical in every Agora lib), with a
 * denial carrying its `reason` and a redirect read as an unauthenticated denial (`302` for a page,
 * `401` for an API call), as the console's routes answer it.
 */
export type ConsoleDecision =
  | {
      allowed: true;
      tenants?: '*' | string[];
      apps?: '*' | string[];
      capabilities?: string[];
      access?: ConsoleAccess;
    }
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

/** The shared decision as the console reads it. */
export function toConsoleDecision(decision: ConsoleAuthorizeDecision): ConsoleDecision {
  if (decision.allowed) return decision;
  if (decision.status === 302) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: decision.redirectTo };
  }
  if (decision.status === 401) return { allowed: false, reason: 'unauthenticated' };
  return {
    allowed: false,
    reason: 'forbidden',
    ...(decision.error !== undefined ? { error: decision.error } : {}),
  };
}

/** Normalize an `authorize` answer (see {@link normalizeConsoleAuthorizeResult}), as the console reads it. */
export function normalizeConsoleDecision(result: unknown): ConsoleDecision {
  return toConsoleDecision(normalizeConsoleAuthorizeResult(result));
}

/**
 * Turn the `authorize` option into the console's per-request gate. Throws at config time for a
 * value that is neither a function, an authorizer class nor a lazy import of one.
 */
export function resolveConsoleGate(authorize: unknown): ConsoleAuthorizeGate {
  if (typeof authorize !== 'function') {
    throw new TypeError(
      '[@adonis-agora/durable] `authorize` must be a function, an authorizer class, or a lazy import of one.',
    );
  }
  const gate = resolveConsoleAuthorize(authorize as ConsoleAuthorize);
  return async (ctx) => toConsoleDecision(await gate(ctx));
}

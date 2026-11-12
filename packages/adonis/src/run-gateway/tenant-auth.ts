import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ContractClass,
  TenantCredentialsContract,
  TenantTokenOption,
  TenantTokenSource,
  TenantVerifier,
  TenantVerifierContract,
  TenantVerifierInput,
  TenantVerifierOption,
  VerifiedTenant,
} from '../config_types.js';

/**
 * Layered tenant auth (spec §9). On a store-less pod the `tenant` on a `RunRequest`/`StartRunMessage`
 * is only a CLAIM; without a signed proof the isolation boundary is meaningless. This module provides
 * the default defense-in-depth on top of prefix/network isolation: a symmetric HMAC token a tenant pod
 * carries and presents in the `tenant` wire field, which the control-plane {@link TenantVerifier}
 * checks and DERIVES the real tenant from — never trusting the body.
 *
 * The token is deliberately tiny and self-describing (`<tenant>.<base64url-hmac>`), so it fits the
 * existing byte-compatible `tenant: string` wire field with NO envelope change: an aviary/Python
 * control plane that doesn't verify simply treats the whole string as the tenant name (and finds no
 * runs — a safe failure), while an Adonis control plane configured with {@link hmacTenantVerifier}
 * verifies the signature and scopes to the embedded tenant.
 *
 * HMAC (shared secret) is the zero-infra default; a deployment that prefers asymmetric / issued tokens
 * supplies its own {@link TenantVerifier} in `config/durable.ts` instead. Prefix/network segmentation
 * is a deployment concern (Redis ACLs, per-tenant prefixes) and lives outside this code.
 */

/** Separator between the tenant claim and its signature in a token. `.` is URL/JSON-safe and never
 *  appears in the base64url signature, so the LAST `.` unambiguously splits the two halves — a tenant
 *  name may itself contain dots. */
const TOKEN_SEP = '.';

/** The HMAC digest, byte-for-byte, that authenticates `tenant` under `secret`. */
function sign(tenant: string, secret: string): string {
  return createHmac('sha256', secret).update(tenant).digest('base64url');
}

/**
 * Mint the signed token a tenant pod presents: `` `${tenant}.${base64url(HMAC-SHA256(secret, tenant))}` ``.
 * Put it on the pod's `config/durable.ts` as `tenant.token`; the pod carries only the token (never the
 * secret), and the control plane verifies it with the SAME `secret` via {@link hmacTenantVerifier}.
 */
export function signTenantToken(
  tenant: string,
  secret: string,
  opts?: {
    /**
     * Optional lifetime: the claim gains a `.exp<epochMs>` suffix, signed together with the tenant,
     * and {@link hmacTenantVerifier} rejects the token once that instant passes. Without it the
     * token never expires — observable broker traffic (an un-ACL'd shared Redis, a dump) then holds
     * a credential valid FOREVER, and rotation means re-keying the whole fleet at once. Additive:
     * expiring and legacy tokens verify side by side, and a non-verifying aviary/Python control
     * plane still treats the whole string as an (unknown) tenant name — a safe failure.
     * Tenant names ending in `.exp<digits>` are reserved by this scheme.
     */
    ttlMs?: number;
    /** Injectable clock for tests. */
    now?: number;
  },
): string {
  const claim =
    opts?.ttlMs !== undefined
      ? `${tenant}${TOKEN_SEP}exp${(opts.now ?? Date.now()) + opts.ttlMs}`
      : tenant;
  return `${claim}${TOKEN_SEP}${sign(claim, secret)}`;
}

/** The trailing expiry marker an expiring token's claim carries (see signTenantToken). */
const EXP_SUFFIX = /\.exp(\d+)$/;

/**
 * Build the control-plane-side {@link TenantVerifier} for {@link signTenantToken}-minted tokens under
 * `secret`. It parses the token, recomputes the HMAC over the embedded tenant, and compares it in
 * CONSTANT TIME (`timingSafeEqual`) — so a tampered tenant, a forged/absent signature, or a token
 * signed with a different secret all return `null` (rejected). The verified tenant is DERIVED from the
 * token's own claim, and the advisory `tenant` on the request body is ignored (spec §9).
 *
 * `capabilities`, if given, is a static grant stamped onto every {@link VerifiedTenant} this verifier
 * authenticates (the HMAC token carries no scoped claims of its own); omit for none.
 */
export function hmacTenantVerifier(
  secret: string | string[],
  capabilities?: string[],
): TenantVerifier {
  // Accepting a LIST of secrets makes rotation a two-step deploy instead of a big bang: verify with
  // [next, current] everywhere first, then re-mint tenant tokens with `next` at leisure.
  const secrets = Array.isArray(secret) ? secret : [secret];
  return ({ token }): VerifiedTenant | null => {
    // The signed token travels in the request's `tenant` field, so the responder passes it as `token`.
    if (typeof token !== 'string' || token.length === 0) return null;
    const sep = token.lastIndexOf(TOKEN_SEP);
    if (sep <= 0 || sep === token.length - 1) return null; // no claim or no signature half
    const claim = token.slice(0, sep);
    const presented = token.slice(sep + 1);
    if (!secrets.some((s) => constantTimeEquals(presented, sign(claim, s)))) return null;
    // Expiring claim (`<tenant>.exp<epochMs>`): the suffix is INSIDE the signature, so an attacker
    // can neither strip nor extend it. Reject once the instant passes; a legacy claim (no suffix)
    // is the tenant verbatim, exactly as before.
    const exp = EXP_SUFFIX.exec(claim);
    if (exp) {
      const expiresAt = Number(exp[1]);
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
      const tenant = claim.slice(0, claim.length - (exp[0]?.length ?? 0));
      if (tenant.length === 0) return null;
      return capabilities !== undefined ? { tenant, capabilities } : { tenant };
    }
    return capabilities !== undefined ? { tenant: claim, capabilities } : { tenant: claim };
  };
}

/** Constant-time string compare that never throws on a length mismatch (`timingSafeEqual` requires
 *  equal-length buffers) and never short-circuits on the first differing byte — so a rejected token
 *  leaks nothing about how much of the signature matched. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// the forms `verifyTenant` and `tenant.token` accept
// ---------------------------------------------------------------------------

/** Builds a contract class. The provider passes the container's `make`, so `@inject()` works. */
export type ContractClassMaker = <T>(Class: ContractClass<T>) => T | Promise<T>;

const construct: ContractClassMaker = (Class) => new Class();

function implementsMethod<T>(value: unknown, method: string): value is T {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}

/**
 * A class: one with the contract method on its prototype, or any `class` declaration (a contract whose
 * method is an instance field, `verify = async () => ...`, has nothing on its prototype). The instance
 * is checked for the method once built.
 */
function isContractClass<T>(value: unknown, method: string): value is ContractClass<T> {
  if (typeof value !== 'function') return false;
  if (
    typeof (value as { prototype?: Record<string, unknown> }).prototype?.[method] === 'function'
  ) {
    return true;
  }
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

/**
 * The class or object a lazy import's module exports as default, or `undefined` when `value` is not a
 * module (no `default` key). A module whose default export is neither throws: it is a misconfigured
 * lazy import, and must never be mistaken for a result.
 */
function lazyDefault<T>(
  value: unknown,
  method: string,
  contract: string,
): ContractClass<T> | T | undefined {
  if (value === null || typeof value !== 'object' || !('default' in value)) return undefined;
  const candidate = (value as { default: unknown }).default;
  if (isContractClass<T>(candidate, method) || implementsMethod<T>(candidate, method)) {
    return candidate;
  }
  throw new TypeError(
    `the lazy import's default export must be a class implementing ${contract} (with a ${method}() method)`,
  );
}

/**
 * One instance per contract class or lazy module, built on first use and checked for the contract's
 * method. A failed build is forgotten, so the next call tries again instead of failing forever.
 */
function memoizedInstance<T>(
  source: ContractClass<T> | T,
  make: ContractClassMaker,
  method: string,
  contract: string,
): () => Promise<T> {
  let instance: Promise<T> | undefined;
  return () => {
    instance ??= Promise.resolve(
      typeof source === 'function' ? make(source as ContractClass<T>) : source,
    )
      .then((built) => {
        if (!implementsMethod<T>(built, method)) {
          throw new TypeError(`${contract} instance has no ${method}() method`);
        }
        return built;
      })
      .catch((err: unknown) => {
        instance = undefined;
        throw err;
      });
    return instance;
  };
}

/** A verifier's answer, checked: `null` rejects, `{ tenant }` with a non-empty string accepts, and
 *  anything else throws, so a malformed result can never be taken for an accepted tenant. */
function checkVerified(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const tenant = (result as { tenant?: unknown }).tenant;
  if (typeof result === 'object' && typeof tenant === 'string' && tenant.length > 0) {
    return result as VerifiedTenant;
  }
  throw new TypeError('`verifyTenant` must return { tenant: string, capabilities? } or null');
}

/**
 * Turn any `verifyTenant` form into the function the responder calls:
 *
 * - a function is called with the request's input; when it resolves to a module whose `default` is a
 *   {@link TenantVerifierContract} class (or object), it was a lazy import: the class is built once
 *   and used from then on;
 * - a class with a `verify` method is built once through `make` (the container in the provider);
 * - an object with a `verify` method is used as-is.
 */
export function resolveTenantVerifier(
  option: TenantVerifierOption,
  make: ContractClassMaker = construct,
): TenantVerifier {
  const V = 'TenantVerifierContract';
  if (implementsMethod<TenantVerifierContract>(option, 'verify')) {
    return async (input) => checkVerified(await option.verify(input));
  }
  if (isContractClass<TenantVerifierContract>(option, 'verify')) {
    const instance = memoizedInstance(option, make, 'verify', V);
    return async (input) => checkVerified(await (await instance()).verify(input));
  }
  if (typeof option !== 'function') {
    throw new TypeError(
      '`verifyTenant` must be a function, a class implementing TenantVerifierContract, or a lazy import of one.',
    );
  }
  const fn = option as (input: TenantVerifierInput) => unknown;
  let lazy: (() => Promise<TenantVerifierContract>) | undefined;
  return async (input) => {
    if (lazy) return checkVerified(await (await lazy()).verify(input));
    const result = await fn(input);
    const source = lazyDefault<TenantVerifierContract>(result, 'verify', V);
    if (source !== undefined) {
      lazy ??= memoizedInstance(source, make, 'verify', V);
      return checkVerified(await (await lazy()).verify(input));
    }
    return checkVerified(result);
  };
}

/**
 * Turn any `tenant.token` form into what the wire layer sends: a string stays a string; a function,
 * a {@link TenantCredentialsContract} class (built once through `make`), an object with a `token`
 * method, or a lazy import of a class becomes a function called before every request.
 */
export function resolveTenantToken(
  option: TenantTokenOption,
  make: ContractClassMaker = construct,
): TenantTokenSource {
  if (typeof option === 'string') return option;
  const C = 'TenantCredentialsContract';
  if (implementsMethod<TenantCredentialsContract>(option, 'token')) {
    return () => option.token();
  }
  if (isContractClass<TenantCredentialsContract>(option, 'token')) {
    const instance = memoizedInstance(option, make, 'token', C);
    return async () => (await instance()).token();
  }
  if (typeof option !== 'function') {
    throw new TypeError(
      '`tenant.token` must be a string, a function, a class implementing TenantCredentialsContract, or a lazy import of one.',
    );
  }
  const fn = option as () => unknown;
  let lazy: (() => Promise<TenantCredentialsContract>) | undefined;
  return async () => {
    if (lazy) return (await lazy()).token();
    const result = await fn();
    const source = lazyDefault<TenantCredentialsContract>(result, 'token', C);
    if (source !== undefined) {
      lazy ??= memoizedInstance(source, make, 'token', C);
      return (await lazy()).token();
    }
    return result as string;
  };
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ContractClass,
  TenantCredentialsContract,
  TenantTokenOption,
  TenantTokenSource,
  TenantVerifier,
  TenantVerifierContract,
  TenantVerifierOption,
  TenantVerifierRequest,
  VerifiedTenant,
} from '../config_types.js';

/**
 * Tenant auth without an identity provider (spec §9). On a store-less pod the `tenant` on a
 * `RunRequest`/`StartRunMessage` is only a CLAIM; without a proof the isolation boundary is
 * meaningless. {@link sharedSecretVerifier} is the zero-infra verifier: one secret per partition,
 * known to the control plane and to that partition's pods. A pod presents either the secret itself
 * or a short-lived token signed with it ({@link signTenantToken}), in the existing `tenant` wire field
 * (no envelope change). The control plane derives the partition from the token, never the body.
 *
 * With an identity provider, use authkit-client's `authkitTenantVerifier` instead (JWT access tokens
 * verified against the issuer's keys); both return the same {@link VerifiedTenant}.
 */

/** Separator between the claim and its signature in a signed token. `.` is URL/JSON-safe and never
 *  appears in the base64url signature, so the LAST `.` unambiguously splits the two halves — a
 *  partition name may itself contain dots. */
const TOKEN_SEP = '.';

/** The HMAC digest, byte-for-byte, that authenticates `claim` under `secret`. */
function sign(claim: string, secret: string): string {
  return createHmac('sha256', secret).update(claim).digest('base64url');
}

/**
 * Mint a signed token for `partition`: `` `${partition}.${base64url(HMAC-SHA256(secret, partition))}` ``
 * (with `ttlMs`, the claim gains a signed `.exp<epochMs>` suffix). Use it as the pod's `tenant.token`
 * when the broker traffic should carry a short-lived token instead of the secret itself; the control
 * plane verifies it with the same partition secret via {@link sharedSecretVerifier}.
 */
export function signTenantToken(
  partition: string,
  secret: string,
  opts?: {
    /**
     * Lifetime: the claim gains a `.exp<epochMs>` suffix, signed together with the partition, and
     * {@link sharedSecretVerifier} rejects the token once that instant passes. Without it the token
     * never expires. Partition names ending in `.exp<digits>` are reserved by this scheme.
     */
    ttlMs?: number;
    /** Injectable clock for tests. */
    now?: number;
  },
): string {
  const claim =
    opts?.ttlMs !== undefined
      ? `${partition}${TOKEN_SEP}exp${(opts.now ?? Date.now()) + opts.ttlMs}`
      : partition;
  return `${claim}${TOKEN_SEP}${sign(claim, secret)}`;
}

/** The trailing expiry marker an expiring token's claim carries (see signTenantToken). */
const EXP_SUFFIX = /\.exp(\d+)$/;

/** One partition of {@link sharedSecretVerifier}. */
export interface SharedSecretPartition {
  /** The partition's secret. A list verifies with any of them, so rotation is two deploys, not one. */
  secret: string | string[];
  /** The environment its tokens are for, returned as `environment`. */
  environment?: string | undefined;
  /** What its tokens grant, e.g. `['tenancy:*']`. Default: none. */
  capabilities?: string[] | undefined;
}

export interface SharedSecretVerifierOptions {
  /** Partition name → its secret (or secrets, or a {@link SharedSecretPartition}). */
  partitions: Record<string, string | string[] | SharedSecretPartition>;
}

interface ResolvedPartition {
  partition: string;
  secrets: string[];
  environment: string | undefined;
  capabilities: string[];
}

/**
 * The control-plane `verifyTenant` for deployments without an identity provider: one shared secret
 * per partition.
 *
 * ```ts
 * verifyTenant: sharedSecretVerifier({
 *   partitions: {
 *     shop: env.get('DURABLE_SHOP_SECRET'),
 *     billing: { secret: env.get('DURABLE_BILLING_SECRET'), capabilities: ['tenancy:*'] },
 *   },
 * })
 * ```
 *
 * A pod's token is either its partition's secret (plain) or a {@link signTenantToken} of it. Every
 * comparison is constant time. A tampered, expired or unknown token returns `null` (rejected). Two
 * partitions sharing a secret, or an empty secret, throw here, at boot.
 */
export function sharedSecretVerifier(options: SharedSecretVerifierOptions): TenantVerifier {
  const entries = Object.entries(options?.partitions ?? {});
  if (entries.length === 0) {
    throw new TypeError('sharedSecretVerifier: `partitions` must name at least one partition');
  }
  const partitions = new Map<string, ResolvedPartition>();
  const owners = new Map<string, string>();
  for (const [partition, entry] of entries) {
    const config: SharedSecretPartition =
      typeof entry === 'string' || Array.isArray(entry) ? { secret: entry } : entry;
    const secrets = Array.isArray(config.secret) ? config.secret : [config.secret];
    if (!partition || secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || !s)) {
      throw new TypeError(
        `sharedSecretVerifier: partition "${partition}" needs a non-empty secret`,
      );
    }
    for (const secret of secrets) {
      const owner = owners.get(secret);
      if (owner !== undefined && owner !== partition) {
        throw new TypeError(
          `sharedSecretVerifier: partitions "${owner}" and "${partition}" share a secret; give each its own`,
        );
      }
      owners.set(secret, partition);
    }
    partitions.set(partition, {
      partition,
      secrets,
      environment: config.environment,
      capabilities: config.capabilities ?? [],
    });
  }

  const accept = (p: ResolvedPartition): VerifiedTenant => ({
    partition: p.partition,
    ...(p.environment !== undefined ? { environment: p.environment } : {}),
    capabilities: [...p.capabilities],
  });

  return ({ token }): VerifiedTenant | null => {
    if (typeof token !== 'string' || token.length === 0) return null;

    // A signed token: `<partition>[.exp<ms>].<sig>`, signed with that partition's secret.
    const sep = token.lastIndexOf(TOKEN_SEP);
    if (sep > 0 && sep < token.length - 1) {
      const claim = token.slice(0, sep);
      const presented = token.slice(sep + 1);
      const exp = EXP_SUFFIX.exec(claim);
      const name = exp ? claim.slice(0, claim.length - (exp[0]?.length ?? 0)) : claim;
      const entry = partitions.get(name);
      if (entry?.secrets.some((s) => constantTimeEquals(presented, sign(claim, s)))) {
        // The expiry is INSIDE the signature, so it can be neither stripped nor extended.
        if (exp) {
          const expiresAt = Number(exp[1]);
          if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
        }
        return accept(entry);
      }
    }

    // The plain secret. Compare against every secret (no early exit) so timing does not reveal
    // which partition, if any, came close.
    let match: ResolvedPartition | undefined;
    for (const entry of partitions.values()) {
      for (const secret of entry.secrets) {
        if (constantTimeEquals(token, secret)) match = entry;
      }
    }
    return match ? accept(match) : null;
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

/** A verifier's answer, checked: `null` rejects, `{ partition }` with a non-empty string accepts, and
 *  anything else throws, so a malformed result can never be taken for an accepted tenant. */
function checkVerified(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const r = result as { partition?: unknown; environment?: unknown; capabilities?: unknown };
  if (typeof result !== 'object' || typeof r.partition !== 'string' || r.partition.length === 0) {
    throw new TypeError(
      '`verifyTenant` must return { partition: string, environment?, capabilities: string[] } or null',
    );
  }
  if (
    r.capabilities !== undefined &&
    (!Array.isArray(r.capabilities) || r.capabilities.some((c) => typeof c !== 'string'))
  ) {
    throw new TypeError('`verifyTenant` returned non-string `capabilities`');
  }
  return {
    partition: r.partition,
    ...(typeof r.environment === 'string' && r.environment ? { environment: r.environment } : {}),
    capabilities: (r.capabilities as string[] | undefined) ?? [],
  };
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
  const fn = option as (request: TenantVerifierRequest) => unknown;
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
 * an object with `get()` or `token()`, a {@link TenantCredentialsContract} class (built once through
 * `make`), or a lazy import of a class becomes a function called before every request.
 */
export function resolveTenantToken(
  option: TenantTokenOption,
  make: ContractClassMaker = construct,
): TenantTokenSource {
  if (typeof option === 'string') return option;
  const C = 'TenantCredentialsContract';
  if (implementsMethod<{ get(): string | Promise<string> }>(option, 'get')) {
    return () => option.get();
  }
  if (implementsMethod<TenantCredentialsContract>(option, 'token')) {
    return () => option.token();
  }
  if (isContractClass<TenantCredentialsContract>(option, 'token')) {
    const instance = memoizedInstance(option, make, 'token', C);
    return async () => (await instance()).token();
  }
  if (typeof option !== 'function') {
    throw new TypeError(
      '`tenant.token` must be a string, a function, an object with get(), a class implementing TenantCredentialsContract, or a lazy import of one.',
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

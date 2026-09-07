import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TenantVerifier, VerifiedTenant } from '../config_types.js';

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

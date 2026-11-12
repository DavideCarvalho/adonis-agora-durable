import { createHash } from 'node:crypto';
import { Secret } from '@adonisjs/core/helpers';
import type {
  TenantVerifierContract,
  TenantVerifierInput,
  VerifiedTenant,
} from '../../../src/index.js';
import ServiceTenant from './service_tenant.js';

/**
 * Verifies the access tokens of `ServiceTenant` rows. The control plane sees every message a tenant
 * sends, so each result, accepted or rejected, is reused for `cacheTtlMs` instead of querying the
 * database every time. A deleted token keeps working for at most that long; an expiring token is
 * never accepted past its expiry.
 */
export default class AccessTokenTenantVerifier implements TenantVerifierContract {
  #cacheTtlMs: number;
  #maxEntries: number;
  #cache = new Map<string, { result: VerifiedTenant | null; until: number }>();

  constructor(options: { cacheTtlMs?: number; maxEntries?: number } = {}) {
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  async verify({ token }: TenantVerifierInput): Promise<VerifiedTenant | null> {
    if (!token) return null;
    // Keyed by a hash, so the cache never holds a usable token.
    const key = createHash('sha256').update(token).digest('base64url');
    const hit = this.#cache.get(key);
    if (hit && hit.until > Date.now()) return hit.result;

    // A database error is thrown, not cached: the request fails and the next one asks again.
    const accessToken = await ServiceTenant.accessTokens.verify(new Secret(token));
    const owner = accessToken ? await ServiceTenant.find(accessToken.tokenableId) : null;
    const result =
      accessToken && owner
        ? { tenant: owner.partition, capabilities: accessToken.abilities }
        : null;

    let until = Date.now() + this.#cacheTtlMs;
    if (accessToken?.expiresAt) until = Math.min(until, accessToken.expiresAt.getTime());
    this.#cache.delete(key);
    this.#cache.set(key, { result, until });
    if (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return result;
  }
}

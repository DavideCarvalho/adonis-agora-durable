import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type {
  TenantVerifierContract,
  TenantVerifierInput,
  VerifiedTenant,
} from '../../../src/index.js';

export interface OidcTenantVerifierOptions {
  /** The IdP's issuer; must equal the token's `iss`. */
  issuer: string;
  /** The control plane's resource identifier; must be in the token's `aud`. */
  audience: string;
  /** The IdP's key set (`jwks_uri` in `{issuer}/.well-known/openid-configuration`). */
  jwksUri: string;
  /** Claim naming the partition. Default `partition`. */
  partitionClaim?: string;
  /** Claim listing the capabilities. Default `capabilities`. */
  capabilitiesClaim?: string;
}

/**
 * Verifies JWT access tokens (RFC 9068) issued by any OIDC provider, locally: the signing keys are
 * fetched once and cached by `jose`, which fetches them again when a token names a key it has not
 * seen (key rotation). Only asymmetric algorithms are accepted, never `none` or `HS*`.
 */
export class OidcTenantVerifier implements TenantVerifierContract {
  #options: OidcTenantVerifierOptions;
  #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: OidcTenantVerifierOptions) {
    this.#options = options;
    this.#jwks = createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verify({ token }: TenantVerifierInput): Promise<VerifiedTenant | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        requiredClaims: ['exp'],
        clockTolerance: 30,
      });
      const tenant = payload[this.#options.partitionClaim ?? 'partition'];
      if (typeof tenant !== 'string' || tenant === '') return null;
      const capabilities = payload[this.#options.capabilitiesClaim ?? 'capabilities'];
      return {
        tenant,
        capabilities: Array.isArray(capabilities)
          ? capabilities.filter((c): c is string => typeof c === 'string')
          : undefined,
      };
    } catch (error) {
      // A bad token is a rejection. A key set that cannot be fetched is an error the tenant sees.
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) return null;
      throw error;
    }
  }
}

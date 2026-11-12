import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '@adonisjs/lucid/database';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMemoryDb } from '../../src/stores/lucid-helpers.js';
import AccessTokenTenantVerifier from '../fixtures/tenant-auth-guide/access_token_tenant_verifier.js';
import { ClientCredentials } from '../fixtures/tenant-auth-guide/client_credentials.js';
import { OidcTenantVerifier } from '../fixtures/tenant-auth-guide/oidc_tenant_verifier.js';
import ServiceTenant from '../fixtures/tenant-auth-guide/service_tenant.js';

/**
 * Runs the examples of the "Authenticate tenants" guide (`docs/cluster/authenticate-tenants.mdx`).
 * The fixtures under `test/fixtures/tenant-auth-guide/` are the guide's classes verbatim except for
 * their import paths; change both together. Everything runs locally: an in-memory SQLite database for
 * `@adonisjs/auth` access tokens, and a local HTTP server standing in for the identity provider.
 */

// ---------------------------------------------------------------------------
// a local identity provider: JWKS + client_credentials token endpoint
// ---------------------------------------------------------------------------

type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };

async function makeKey(kid: string, alg = 'ES256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

const AUDIENCE = 'urn:agora:durable';

class LocalIdp {
  server!: Server;
  issuer = '';
  published: Key[] = [];
  signingKey!: Key;
  jwksFetches = 0;
  tokenRequests: { auth: string | undefined; body: URLSearchParams }[] = [];
  tokenStatus = 200;
  tokenTtlSec = 600;
  tokenDelayMs = 0;

  async start(): Promise<void> {
    this.signingKey = await makeKey('k1');
    this.published = [this.signingKey];
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get jwksUri() {
    return `${this.issuer}/jwks`;
  }
  get tokenEndpoint() {
    return `${this.issuer}/token`;
  }

  sign(claims: Record<string, unknown>, opts: { key?: Key; expSec?: number } = {}) {
    const key = opts.key ?? this.signingKey;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: this.issuer, aud: AUDIENCE, sub: 'svc', ...claims })
      .setProtectedHeader({ alg: key.jwk.alg as string, kid: key.kid, typ: 'at+jwt' })
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expSec ?? 600))
      .sign(key.privateKey);
  }

  async #handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (req.url === '/jwks') {
      this.jwksFetches++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: this.published.map((k) => k.jwk) }));
      return;
    }
    if (req.url === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      this.tokenRequests.push({ auth: req.headers.authorization, body: new URLSearchParams(raw) });
      if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      res.setHeader('content-type', 'application/json');
      if (this.tokenStatus !== 200) {
        res.statusCode = this.tokenStatus;
        res.end(JSON.stringify({ error: 'invalid_client', error_description: 'secret xyz wrong' }));
        return;
      }
      const token = await this.sign(
        { partition: 'acme', capabilities: ['gpu'], n: this.tokenRequests.length },
        { expSec: this.tokenTtlSec },
      );
      res.end(
        JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: this.tokenTtlSec }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  }
}

// ---------------------------------------------------------------------------
// OIDC: OidcTenantVerifier
// ---------------------------------------------------------------------------

describe('guide: OidcTenantVerifier (any OIDC IdP, verified with jose)', () => {
  const idp = new LocalIdp();
  let verifier: OidcTenantVerifier;

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  beforeEach(() => {
    idp.published = [idp.signingKey];
    verifier = new OidcTenantVerifier({
      issuer: idp.issuer,
      audience: AUDIENCE,
      jwksUri: idp.jwksUri,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('accepts a valid token and derives { tenant, capabilities } from its claims', async () => {
    const token = await idp.sign({ partition: 'acme', capabilities: ['gpu', 'saga'] });
    expect(await verifier.verify({ token, tenant: 'ignored' })).toEqual({
      tenant: 'acme',
      capabilities: ['gpu', 'saga'],
    });
  });

  it('capabilities are optional', async () => {
    const token = await idp.sign({ partition: 'acme' });
    expect(await verifier.verify({ token })).toEqual({ tenant: 'acme', capabilities: undefined });
  });

  it('rejects a wrong audience, a wrong issuer, an expired token and a missing partition', async () => {
    expect(
      await verifier.verify({ token: await idp.sign({ partition: 'a', aud: 'urn:other' }) }),
    ).toBeNull();
    expect(
      await verifier.verify({ token: await idp.sign({ partition: 'a', iss: 'https://evil' }) }),
    ).toBeNull();
    expect(
      await verifier.verify({ token: await idp.sign({ partition: 'a' }, { expSec: -120 }) }),
    ).toBeNull();
    expect(await verifier.verify({ token: await idp.sign({}) })).toBeNull();
    expect(await verifier.verify({ token: await idp.sign({ partition: '' }) })).toBeNull();
    expect(await verifier.verify({})).toBeNull();
    expect(await verifier.verify({ token: 'not-a-jwt' })).toBeNull();
  });

  it('rejects HS256 (even keyed with the public JWK) and alg none', async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs = await new SignJWT({ iss: idp.issuer, aud: AUDIENCE, partition: 'acme' })
      .setProtectedHeader({ alg: 'HS256', kid: idp.signingKey.kid })
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(JSON.stringify(idp.signingKey.jwk)));
    expect(await verifier.verify({ token: hs })).toBeNull();

    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const none = `${b64({ alg: 'none' })}.${b64({ iss: idp.issuer, aud: AUDIENCE, partition: 'acme', exp: now + 600 })}.`;
    expect(await verifier.verify({ token: none })).toBeNull();
  });

  it('rejects a token signed by a key the IdP does not publish', async () => {
    const stranger = await makeKey('k1'); // same kid, different key
    expect(
      await verifier.verify({ token: await idp.sign({ partition: 'a' }, { key: stranger }) }),
    ).toBeNull();
  });

  it('caches the keys: many verifications, one JWKS fetch', async () => {
    const before = idp.jwksFetches;
    const token = await idp.sign({ partition: 'acme' });
    for (let i = 0; i < 5; i++) await verifier.verify({ token });
    expect(idp.jwksFetches - before).toBe(1);
  });

  it('follows a key rotation: a token from a new kid triggers one refetch (after the cooldown)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await verifier.verify({ token: await idp.sign({ partition: 'acme' }) })).toMatchObject({
      tenant: 'acme',
    });
    const rotated = await makeKey('k2');
    idp.published = [idp.signingKey, rotated];
    vi.setSystemTime(Date.now() + 31_000); // past jose's 30 s refetch cooldown
    const before = idp.jwksFetches;
    const token = await idp.sign({ partition: 'acme' }, { key: rotated });
    expect(await verifier.verify({ token })).toMatchObject({ tenant: 'acme' });
    expect(idp.jwksFetches - before).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OIDC: ClientCredentials
// ---------------------------------------------------------------------------

describe('guide: ClientCredentials (tenant side)', () => {
  const idp = new LocalIdp();
  const credentials = () =>
    new ClientCredentials({
      tokenEndpoint: idp.tokenEndpoint,
      clientId: 'tenant-acme',
      clientSecret: 's3cr3t:/+',
      resource: AUDIENCE,
    });

  beforeAll(() => idp.start());
  afterAll(() => idp.stop());
  beforeEach(() => {
    idp.tokenRequests = [];
    idp.tokenStatus = 200;
    idp.tokenTtlSec = 600;
    idp.tokenDelayMs = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('sends client_credentials with the resource and HTTP Basic auth', async () => {
    await credentials().token();
    const [request] = idp.tokenRequests;
    expect(request?.body.get('grant_type')).toBe('client_credentials');
    expect(request?.body.get('resource')).toBe(AUDIENCE);
    const decoded = Buffer.from(String(request?.auth).replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe(`tenant-acme:${encodeURIComponent('s3cr3t:/+')}`);
  });

  it('reuses the token until refreshSkewSec before it expires, then fetches a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const source = credentials();
    const first = await source.token();
    expect(await source.token()).toBe(first);
    vi.setSystemTime(Date.now() + 530_000); // 70 s before expiry: still fresh
    expect(await source.token()).toBe(first);
    vi.setSystemTime(Date.now() + 20_000); // 50 s before expiry: refresh
    const second = await source.token();
    expect(second).not.toBe(first);
    expect(idp.tokenRequests).toHaveLength(2);
  });

  it('concurrent calls share one request (single flight)', async () => {
    idp.tokenDelayMs = 50;
    const source = credentials();
    const tokens = await Promise.all(Array.from({ length: 10 }, () => source.token()));
    expect(new Set(tokens).size).toBe(1);
    expect(idp.tokenRequests).toHaveLength(1);
  });

  it('when the IdP fails, keeps the still-valid token and backs off; never leaks the response', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const source = credentials();
    const first = await source.token();
    idp.tokenStatus = 401;
    vi.setSystemTime(Date.now() + 560_000); // inside the refresh window, token still valid
    expect(await source.token()).toBe(first);
    expect(await source.token()).toBe(first); // backing off: no second request
    expect(idp.tokenRequests).toHaveLength(2);

    const fresh = credentials();
    const error = await fresh.token().catch((e: Error) => e);
    expect(String(error)).toMatch(/HTTP 401/);
    expect(String(error)).not.toMatch(/xyz|s3cr3t/);
  });

  it('end to end: the token it gets is accepted by OidcTenantVerifier', async () => {
    const verifier = new OidcTenantVerifier({
      issuer: idp.issuer,
      audience: AUDIENCE,
      jwksUri: idp.jwksUri,
    });
    expect(await verifier.verify({ token: await credentials().token() })).toEqual({
      tenant: 'acme',
      capabilities: ['gpu'],
    });
  });
});

// ---------------------------------------------------------------------------
// @adonisjs/auth access tokens: AccessTokenTenantVerifier
// ---------------------------------------------------------------------------

describe('guide: AccessTokenTenantVerifier (@adonisjs/auth access tokens)', () => {
  let db: Database;

  beforeAll(async () => {
    db = makeMemoryDb();
    await db.connection().schema.createTable('service_tenants', (t) => {
      t.increments('id');
      t.string('partition').notNullable();
    });
    await db.connection().schema.createTable('auth_access_tokens', (t) => {
      t.increments('id');
      t.integer('tokenable_id').notNullable();
      t.string('type').notNullable();
      t.string('name').nullable();
      t.string('hash').notNullable();
      t.text('abilities').notNullable();
      t.timestamp('created_at');
      t.timestamp('updated_at');
      t.timestamp('last_used_at').nullable();
      t.timestamp('expires_at').nullable();
    });
    ServiceTenant.useAdapter(db.modelAdapter());
  });
  afterAll(() => db.manager.closeAll());

  async function mint(partition: string, abilities = ['*'], expiresIn?: string) {
    const tenant = await ServiceTenant.create({ partition });
    const token = await ServiceTenant.accessTokens.create(
      tenant,
      abilities,
      expiresIn ? { expiresIn } : {},
    );
    return { tenant, token, value: token.value?.release() as string };
  }

  it("accepts a token and maps its owner's partition and the token's abilities", async () => {
    const { value } = await mint('acme', ['gpu']);
    const verifier = new AccessTokenTenantVerifier();
    expect(await verifier.verify({ token: value, tenant: 'claimed' })).toEqual({
      tenant: 'acme',
      capabilities: ['gpu'],
    });
  });

  it('rejects an unknown, tampered or absent token', async () => {
    const { value } = await mint('globex');
    const verifier = new AccessTokenTenantVerifier();
    expect(await verifier.verify({ token: `${value}x` })).toBeNull();
    expect(await verifier.verify({ token: 'dtt_bogus.value' })).toBeNull();
    expect(await verifier.verify({})).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { value } = await mint('initech', ['*'], '1s');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      expect(await new AccessTokenTenantVerifier().verify({ token: value })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches results: one database lookup per token per TTL, accepted or rejected', async () => {
    const { value } = await mint('umbrella');
    const spy = vi.spyOn(ServiceTenant.accessTokens, 'verify');
    const verifier = new AccessTokenTenantVerifier();
    for (let i = 0; i < 5; i++) await verifier.verify({ token: value });
    for (let i = 0; i < 5; i++) await verifier.verify({ token: 'dtt_nope.nope' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('a revoked token stops working once its cached result expires', async () => {
    const { tenant, token, value } = await mint('hooli');
    const verifier = new AccessTokenTenantVerifier({ cacheTtlMs: 1_000 });
    expect(await verifier.verify({ token: value })).toMatchObject({ tenant: 'hooli' });
    await ServiceTenant.accessTokens.delete(tenant, token.identifier);
    expect(await verifier.verify({ token: value })).toMatchObject({ tenant: 'hooli' }); // cached
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 1_500);
      expect(await verifier.verify({ token: value })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never caches an accepted token past its expiry', async () => {
    const { value } = await mint('stark', ['*'], '2s');
    const verifier = new AccessTokenTenantVerifier({ cacheTtlMs: 60_000 });
    expect(await verifier.verify({ token: value })).toMatchObject({ tenant: 'stark' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3_000);
      expect(await verifier.verify({ token: value })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

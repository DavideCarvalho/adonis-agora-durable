import type { Database } from '@adonisjs/lucid/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeMemoryDb } from '../../src/stores/lucid-helpers.js';
import AccessTokenTenantVerifier from '../fixtures/tenant-auth-guide/access_token_tenant_verifier.js';
import ServiceTenant from '../fixtures/tenant-auth-guide/service_tenant.js';

/**
 * Runs the examples of the "Authenticate tenants" guide (`docs/cluster/authenticate-tenants.mdx`).
 * The fixtures under `test/fixtures/tenant-auth-guide/` are the guide's classes verbatim except for
 * their import paths; change both together. Everything runs locally: an in-memory SQLite database for
 * `@adonisjs/auth` access tokens. The authkit helpers are covered in `tenant-auth-authkit.spec.ts`.
 */

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
    expect(await verifier.verify({ token: value, partition: 'claimed' })).toEqual({
      partition: 'acme',
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
    expect(await verifier.verify({ token: value })).toMatchObject({ partition: 'hooli' });
    await ServiceTenant.accessTokens.delete(tenant, token.identifier);
    expect(await verifier.verify({ token: value })).toMatchObject({ partition: 'hooli' }); // cached
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
    expect(await verifier.verify({ token: value })).toMatchObject({ partition: 'stark' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3_000);
      expect(await verifier.verify({ token: value })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

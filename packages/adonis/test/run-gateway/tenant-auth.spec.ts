import { describe, expect, it } from 'vitest';
import { sharedSecretVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';

const ACME = 'acme-secret-signing-key';
const GLOBEX = 'globex-secret-signing-key';

// `await` (not `.resolves`) because the shared-secret verifier answers SYNCHRONOUSLY — awaiting a plain
// value is a no-op, so the same assertions would also hold for an async verifier.
describe('sharedSecretVerifier (one secret per partition, spec §9)', () => {
  const verify = sharedSecretVerifier({ partitions: { acme: ACME, globex: GLOBEX } });

  it('accepts the plain partition secret and DERIVES the partition from it', async () => {
    expect(await verify({ token: ACME })).toEqual({ partition: 'acme', capabilities: [] });
    expect(await verify({ token: GLOBEX })).toEqual({ partition: 'globex', capabilities: [] });
  });

  it('accepts a token signed with the partition secret', async () => {
    expect(await verify({ token: signTenantToken('acme', ACME) })).toEqual({
      partition: 'acme',
      capabilities: [],
    });
  });

  it('derives the partition from the TOKEN, ignoring the advisory `partition` claim', async () => {
    expect(await verify({ token: ACME, partition: 'globex' })).toEqual({
      partition: 'acme',
      capabilities: [],
    });
  });

  it('returns the configured environment and capabilities', async () => {
    const v = sharedSecretVerifier({
      partitions: {
        acme: { secret: ACME, environment: 'production', capabilities: ['tenancy:*'] },
      },
    });
    expect(await v({ token: ACME })).toEqual({
      partition: 'acme',
      environment: 'production',
      capabilities: ['tenancy:*'],
    });
  });

  it("REJECTS a token signed with ANOTHER partition's secret (no cross-partition minting)", async () => {
    // globex knows its own secret only; signing acme's name with it must not pass as acme.
    expect(await verify({ token: signTenantToken('acme', GLOBEX) })).toBeNull();
  });

  it('REJECTS a tampered claim, a tampered signature and an unknown secret', async () => {
    const token = signTenantToken('acme', ACME);
    const sig = token.slice(token.lastIndexOf('.') + 1);
    expect(await verify({ token: `globex.${sig}` })).toBeNull();
    expect(await verify({ token: `${token}x` })).toBeNull();
    expect(await verify({ token: 'not-a-secret' })).toBeNull();
    expect(await verify({ token: `${ACME}x` })).toBeNull();
  });

  it('REJECTS an expired signed token and accepts it before expiry', async () => {
    const expired = signTenantToken('acme', ACME, { ttlMs: 1_000, now: Date.now() - 10_000 });
    expect(await verify({ token: expired })).toBeNull();
    const fresh = signTenantToken('acme', ACME, { ttlMs: 60_000 });
    expect(await verify({ token: fresh })).toEqual({ partition: 'acme', capabilities: [] });
  });

  it('REJECTS a malformed / empty token', async () => {
    expect(await verify({ token: '' })).toBeNull();
    expect(await verify({ token: undefined })).toBeNull();
    expect(await verify({ token: 'acme.' })).toBeNull();
    expect(await verify({ token: '.sig' })).toBeNull();
  });

  it('verifies with any secret of a list (rotation)', async () => {
    const v = sharedSecretVerifier({ partitions: { acme: ['next-secret', ACME] } });
    expect(await v({ token: ACME })).toEqual({ partition: 'acme', capabilities: [] });
    expect(await v({ token: signTenantToken('acme', 'next-secret') })).toEqual({
      partition: 'acme',
      capabilities: [],
    });
  });

  it('preserves a partition name containing dots (splits on the LAST separator)', async () => {
    const v = sharedSecretVerifier({ partitions: { 'team.acme.eu': ACME } });
    expect(await v({ token: signTenantToken('team.acme.eu', ACME) })).toEqual({
      partition: 'team.acme.eu',
      capabilities: [],
    });
  });

  it('refuses at construction: no partitions, an empty secret, a secret shared by two partitions', () => {
    expect(() => sharedSecretVerifier({ partitions: {} })).toThrow(/at least one partition/);
    expect(() => sharedSecretVerifier({ partitions: { acme: '' } })).toThrow(/non-empty secret/);
    expect(() => sharedSecretVerifier({ partitions: { acme: [] } })).toThrow(/non-empty secret/);
    expect(() => sharedSecretVerifier({ partitions: { acme: ACME, globex: ACME } })).toThrow(
      /share a secret/,
    );
  });
});

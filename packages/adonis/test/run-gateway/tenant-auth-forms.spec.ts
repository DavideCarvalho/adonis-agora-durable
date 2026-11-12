import { Container } from '@adonisjs/core/container';
import { describe, expect, it } from 'vitest';
import type {
  TenantCredentialsContract,
  TenantVerifierContract,
  TenantVerifierInput,
} from '../../src/config_types.js';
import { defineConfig } from '../../src/define_config.js';
import {
  hmacTenantVerifier,
  resolveTenantToken,
  resolveTenantVerifier,
  signTenantToken,
} from '../../src/run-gateway/tenant-auth.js';

/** A dependency the container builds and injects. */
class TenantDirectory {
  readonly lookups: string[] = [];
  partitionOf(token: string): string | null {
    this.lookups.push(token);
    return token.startsWith('good:') ? token.slice('good:'.length) : null;
  }
}

class DirectoryVerifier implements TenantVerifierContract {
  constructor(readonly directory: TenantDirectory) {}
  verify({ token }: TenantVerifierInput) {
    const tenant = token ? this.directory.partitionOf(token) : null;
    return tenant ? { tenant, capabilities: ['read'] } : null;
  }
}

class Vault {
  reads = 0;
  read(): string {
    this.reads++;
    return `vault-token-${this.reads}`;
  }
}

class VaultCredentials implements TenantCredentialsContract {
  constructor(readonly vault: Vault) {}
  async token() {
    return this.vault.read();
  }
}

/**
 * The container's `make`, as the provider passes it. The bindings stand in for `@inject()`, which needs
 * `reflect-metadata` (not a dependency of this package): either way the container builds the class
 * with its dependencies.
 */
function maker() {
  const container = new Container();
  container.bind(DirectoryVerifier, () => new DirectoryVerifier(new TenantDirectory()));
  container.bind(VaultCredentials, () => new VaultCredentials(new Vault()));
  let builds = 0;
  return {
    container,
    builds: () => builds,
    make: <T>(Class: new (...args: never[]) => T) => {
      builds++;
      return container.make(Class);
    },
  };
}

describe('resolveTenantVerifier', () => {
  it('function form: called with the input, its result returned (hmacTenantVerifier keeps working)', async () => {
    const verify = resolveTenantVerifier(hmacTenantVerifier('s3cret'));
    expect(await verify({ token: signTenantToken('acme', 's3cret') })).toEqual({ tenant: 'acme' });
    expect(await verify({ token: signTenantToken('acme', 'other') })).toBeNull();
  });

  it('class form: built once through the container (constructor DI works) and verify() called', async () => {
    const m = maker();
    const verify = resolveTenantVerifier(DirectoryVerifier, m.make);
    expect(await verify({ token: 'good:acme' })).toEqual({
      tenant: 'acme',
      capabilities: ['read'],
    });
    expect(await verify({ token: 'bad' })).toBeNull();
    expect(m.builds()).toBe(1);
  });

  it('lazy import: imported and built once, then used for every request', async () => {
    const m = maker();
    let imports = 0;
    const verify = resolveTenantVerifier(async () => {
      imports++;
      return { default: DirectoryVerifier };
    }, m.make);
    const results = await Promise.all([
      verify({ token: 'good:acme' }),
      verify({ token: 'good:globex' }),
    ]);
    expect(results).toEqual([
      { tenant: 'acme', capabilities: ['read'] },
      { tenant: 'globex', capabilities: ['read'] },
    ]);
    expect(await verify({ token: 'nope' })).toBeNull();
    expect(imports).toBeLessThanOrEqual(2); // concurrent first calls may both import; never again after
    expect(m.builds()).toBe(1);
    await verify({ token: 'good:x' });
    expect(imports).toBeLessThanOrEqual(2);
  });

  it('object form: an instance implementing the contract is used as-is', async () => {
    const instance = new DirectoryVerifier(new TenantDirectory());
    const verify = resolveTenantVerifier(instance);
    expect(await verify({ token: 'good:acme' })).toMatchObject({ tenant: 'acme' });
    expect(instance.directory.lookups).toEqual(['good:acme']);
  });

  it('a class whose build fails is retried on the next request', async () => {
    let fail = true;
    const verify = resolveTenantVerifier(DirectoryVerifier, (Class) => {
      if (fail) throw new Error('container not ready');
      return new Class(new TenantDirectory());
    });
    await expect(verify({ token: 'good:acme' })).rejects.toThrow('container not ready');
    fail = false;
    expect(await verify({ token: 'good:acme' })).toMatchObject({ tenant: 'acme' });
  });

  it('a verifier that throws propagates the error (the responder answers it as an error reply)', async () => {
    const verify = resolveTenantVerifier(() => {
      throw new Error('jwks down');
    });
    await expect(verify({ token: 't' })).rejects.toThrow('jwks down');
  });

  it('rejects a value that is none of the forms', () => {
    expect(() => resolveTenantVerifier('secret' as never)).toThrow(TypeError);
  });
});

describe('resolveTenantToken', () => {
  it('a string stays a string', () => {
    expect(resolveTenantToken('static-token')).toBe('static-token');
  });

  it('a function is passed through and called per request', async () => {
    let calls = 0;
    const token = resolveTenantToken(() => `t${++calls}`);
    expect(typeof token).toBe('function');
    const fn = token as () => Promise<string>;
    expect(await fn()).toBe('t1');
    expect(await fn()).toBe('t2');
  });

  it('class form: built once through the container (constructor DI works), token() called per request', async () => {
    const m = maker();
    const fn = resolveTenantToken(VaultCredentials, m.make) as () => Promise<string>;
    expect(await fn()).toBe('vault-token-1');
    expect(await fn()).toBe('vault-token-2');
    expect(m.builds()).toBe(1);
  });

  it('lazy import: the module is imported once, its class built once', async () => {
    const m = maker();
    let imports = 0;
    const fn = resolveTenantToken(async () => {
      imports++;
      return { default: VaultCredentials };
    }, m.make) as () => Promise<string>;
    expect(await fn()).toBe('vault-token-1');
    expect(await fn()).toBe('vault-token-2');
    expect(imports).toBe(1);
    expect(m.builds()).toBe(1);
  });

  it('object form: an instance with token() is called per request', async () => {
    const fn = resolveTenantToken({ token: () => 'from-object' }) as () => Promise<string>;
    expect(await fn()).toBe('from-object');
  });

  it('rejects a value that is none of the forms', () => {
    expect(() => resolveTenantToken(42 as never)).toThrow(TypeError);
  });
});

describe('config types accept every form', () => {
  it('verifyTenant and tenant.token type-check in each form', () => {
    defineConfig({ topology: 'standalone', verifyTenant: hmacTenantVerifier('s') });
    defineConfig({ topology: 'standalone', verifyTenant: DirectoryVerifier });
    defineConfig({
      topology: 'standalone',
      verifyTenant: async () => ({ default: DirectoryVerifier }),
    });
    defineConfig({
      topology: 'standalone',
      verifyTenant: new DirectoryVerifier(new TenantDirectory()),
    });
    defineConfig({ topology: 'tenant', transport: 'q', partition: 'a', tenant: { token: 'x' } });
    defineConfig({
      topology: 'tenant',
      transport: 'q',
      partition: 'a',
      tenant: { token: async () => 'x' },
    });
    defineConfig({
      topology: 'tenant',
      transport: 'q',
      partition: 'a',
      tenant: { token: VaultCredentials },
    });
    defineConfig({
      topology: 'tenant',
      transport: 'q',
      partition: 'a',
      tenant: { token: async () => ({ default: VaultCredentials }) },
    });
    expect(true).toBe(true);
  });
});

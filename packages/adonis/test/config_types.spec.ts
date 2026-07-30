import { describe, expect, it } from 'vitest';
import type { ControlPlaneConfig, StandaloneConfig, TenantConfig } from '../src/config_types.js';
import { defineConfig, stores, transports } from '../src/define_config.js';

/**
 * Wave-1 Piece B — the role-discriminated `DurableConfig` union (spec §5).
 *
 * This file has TWO layers:
 *  - **Type-level** assertions in `typeContracts()` — never executed, but type-checked by
 *    `tsconfig.tests.json` (the package `tsconfig.json` excludes `test/**`, and vitest strips
 *    types via swc, so neither would catch a `@ts-expect-error`). Run them with:
 *      `pnpm typecheck` (or `node_modules/.bin/tsc -p tsconfig.tests.json`)
 *    Prove-by-mutation: delete `store?: never` from {@link TenantConfig} and the `@ts-expect-error`
 *    on the store-bearing tenant config becomes "unused", failing the type-check.
 *  - **Runtime** assertions in the `describe` block — run by vitest — proving the `role` default.
 */

// --- minimal type-equality helpers (no vitest `expectTypeOf` dependency) ---
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

/**
 * Compile-time proof of the discrimination. Never called — `tsc` still checks it. Each block asserts
 * a valid per-role config both compiles AND narrows to the right union member; each `@ts-expect-error`
 * asserts an invalid shape is rejected.
 */
function typeContracts(): void {
  // A config with NO role narrows to StandaloneConfig (the default member) and keeps every legacy field.
  const legacy = defineConfig({
    transport: 'memory',
    transports: { memory: transports.memory() },
    store: 'lucid',
    stores: { lucid: stores.lucid() },
    namespace: 'pool-a',
  });
  type _Legacy = Expect<Equal<typeof legacy, StandaloneConfig>>;

  // An explicit standalone role narrows the same way.
  const standalone = defineConfig({ role: 'standalone', transport: 'memory' });
  type _Standalone = Expect<Equal<typeof standalone, StandaloneConfig>>;

  // A control-plane config narrows to ControlPlaneConfig and accepts `verifyTenant`.
  const controlPlane = defineConfig({
    role: 'control-plane',
    store: 'lucid',
    stores: { lucid: stores.lucid() },
    transport: 'bull',
    transports: { bull: transports.memory() },
    verifyTenant: ({ token }) => (token ? { tenant: 'acme' } : null),
  });
  type _ControlPlane = Expect<Equal<typeof controlPlane, ControlPlaneConfig>>;

  // A tenant config narrows to TenantConfig — store-less, with partition + wire options.
  const tenant = defineConfig({
    role: 'tenant',
    partition: 'acme',
    transport: 'bull',
    transports: { bull: transports.memory() },
    tenant: { token: 'signed-claim' },
    capabilities: ['saga', 'search-attr-v2'],
    requestTimeoutMs: 5_000,
  });
  type _Tenant = Expect<Equal<typeof tenant, TenantConfig>>;

  // THE KEY CONTRACT — a store-less tenant pod may not name a store. `store?: never` makes this a
  // compile error (`Type 'string' is not assignable to type 'never'`), so isolation is enforced by
  // the type system, not a runtime check. (The directive sits on the call line because that is where
  // an overload-resolution error surfaces.)
  // @ts-expect-error — `store` is forbidden on a tenant config (store?: never — compile-time isolation)
  defineConfig({ role: 'tenant', partition: 'acme', transport: 'bull', store: 'lucid' });

  // ...and it may not carry a `stores` map either.
  // @ts-expect-error — `stores` is forbidden on a tenant config (stores?: never)
  defineConfig({
    role: 'tenant',
    partition: 'acme',
    transport: 'bull',
    stores: { lucid: stores.lucid() },
  });

  // `partition` is required on a tenant config.
  // @ts-expect-error — missing required `partition`
  defineConfig({ role: 'tenant', transport: 'bull' });

  // `store`/`transport` are required on a control-plane config.
  // @ts-expect-error — missing required `store` and `transport`
  defineConfig({ role: 'control-plane' });
}
// Reference (never call) so the type-level assertions are compiled but not run at test time.
void typeContracts;

describe('defineConfig — role-discriminated config', () => {
  it('defaults the role to standalone when omitted (backward-compat)', () => {
    // Prove-by-mutation: remove `role: 'standalone'` from defineConfig's return and this fails.
    expect(defineConfig({}).role).toBe('standalone');
    expect(defineConfig().role).toBe('standalone');
  });

  it('preserves an explicitly-set role', () => {
    expect(
      defineConfig({
        role: 'control-plane',
        store: 'lucid',
        stores: { lucid: stores.lucid() },
        transport: 'bull',
        transports: { bull: transports.memory() },
      }).role,
    ).toBe('control-plane');

    expect(
      defineConfig({
        role: 'tenant',
        partition: 'acme',
        transport: 'bull',
        transports: { bull: transports.memory() },
      }).role,
    ).toBe('tenant');
  });

  it('returns the config fields unchanged, with the role stamped on', () => {
    const cfg = defineConfig({
      namespace: 'pool-a',
      store: 'lucid',
      stores: { lucid: stores.lucid() },
      transport: 'memory',
      transports: { memory: transports.memory() },
    });
    expect(cfg).toMatchObject({
      role: 'standalone',
      namespace: 'pool-a',
      store: 'lucid',
      transport: 'memory',
    });
  });
});

---
"@adonis-agora/durable": major
---

**Breaking: the config's `role` is renamed to `topology`**, with the same values (`'standalone' | 'control-plane' | 'tenant'`), the same default (`'standalone'`) and the same behaviour. No alias: a `role` key in `config/durable.ts` is now a type error, and at runtime it is ignored (the app boots as `standalone`). `role` is reserved across Agora for the split-deployment axis (`'all' | 'api' | 'worker'`); durable covers that with `drive`, `consumers` and `worker.embedded`.

- `StandaloneConfig`, `ControlPlaneConfig` and `TenantConfig` are discriminated on `topology`; `defineConfig` defaults `topology` to `'standalone'`.
- `StoreRunGateway`'s option is `{ topology }` (was `{ role }`).
- `dashboardEngineForRole` (from `@adonis-agora/durable/dashboard`) is renamed `dashboardEngineForTopology`.
- The optional `Transport.useTenantRole()` hook is renamed `useTenantTopology()`; a custom transport that implements it must rename it.
- `durable:worker`'s warning and the provider's boot errors say `topology`.
- The docs page "Roles & config" is now [Topology & config](https://davidecarvalho.github.io/agora/docs/durable/cluster/topology-and-config).

Unchanged: `runGateway.topology()` and `GET <path>/api/topology` still answer `{ role, tenant? }`, the wire shape shared with Aviary's `DurableTopology`.

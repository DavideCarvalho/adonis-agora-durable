---
"@adonis-agora/durable": minor
---

Tenant auth follows the Agora topology convention, the same in every lib with a control plane. Breaking, with no aliases:

- `verifyTenant` returns `{ partition, environment?, capabilities }` (was `{ tenant, capabilities? }`) and receives `{ token, partition? }` (was `{ token, tenant? }`). A verifier that returns the old `{ tenant }` shape fails the request instead of accepting it. Types: `VerifiedTenant` (new shape), `TenantVerifierRequest` (was `TenantVerifierInput`). authkit-client's `authkitTenantVerifier({ issuer, resource: 'urn:agora:durable' })` plugs in as-is, on any server.
- A tenant pod's `partition` moves into the `tenant` block: `tenant: { partition, token, url? }`. `defineConfig` throws at boot on the old top-level `partition`. `tenant.token` also accepts an object with `get()`.
- `hmacTenantVerifier(secret, capabilities)` is replaced by `sharedSecretVerifier({ partitions })`: one secret per partition (a string, a list for rotation, or `{ secret, environment?, capabilities? }`). A pod sends its partition's secret, or a `signTenantToken(partition, secret, { ttlMs })` token signed with it.

The "Authenticate tenants" guide now uses `authkitTenantVerifier` / `authkitTenantToken` from `@adonis-agora/authkit-client` instead of the copy-paste OIDC recipe, and works with authkit on another server. Durable does not depend on authkit.

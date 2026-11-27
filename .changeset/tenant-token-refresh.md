---
"@adonis-agora/durable": patch
---

A tenant pod now recovers from a refused token. When the control plane answers a run read, control or start with `unauthorized` (an expired or revoked token, or a Hub that restarted with new signing keys), the `ProxyRunGateway` drops the token source's cached token (`reset()`, which authkit-client's `tenantOf(...).token` and `authkitTenantToken(...)` have) and retries the request once with a fresh one; a start keeps its `runId`. `resolveTenantToken` keeps `reset()` from every token form (a function, an object with `get()` and `reset()`/`invalidate()`, a `TenantCredentialsContract` with an optional `reset()`). `node ace configure @adonis-agora/durable --topology=tenant` writes a tenant pod's `config/durable.ts` in the one-line form, with the explicit `tenant` block as a comment.

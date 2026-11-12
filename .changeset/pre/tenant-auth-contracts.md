---
"@adonis-agora/durable": minor
---

Tenant authentication works with any auth stack. `tenant.token` now also accepts a function, called before every request so a short-lived token (an OAuth access token, an `@adonisjs/auth` access token read from a vault) can refresh itself; the wire format is unchanged. Two new interfaces, `TenantVerifierContract` (`verify()`) and `TenantCredentialsContract` (`token()`), let you write `verifyTenant` and `tenant.token` as classes: both settings accept a function, a class built through the container (`@inject()` works), a lazy import of one, or an object implementing the contract. `hmacTenantVerifier` and `signTenantToken` are unchanged. A new "Authenticate tenants" guide has working setups for `@adonisjs/auth` access tokens, authkit, any OIDC provider, and HMAC.

---
'@adonis-agora/durable': minor
---

The dashboard `authorize` hook now accepts the shared Agora dashboard-gate contract: it may return
`boolean | AuthorizeDecision`, where `AuthorizeDecision = { allowed: boolean; reason?: 'unauthenticated' | 'forbidden' }`
(both types exported from `@adonis-agora/durable/dashboard`, alongside `normalizeAuthorizeResult`).

- `true` / `{ allowed: true }` → the request proceeds.
- `{ allowed: false, reason: 'unauthenticated' }` → `401` (`{ error: 'unauthorized' }` for the API, the
  "Sign in required" access-denied page for a browser).
- `{ allowed: false, reason: 'forbidden' }`, `{ allowed: false }` or `false` → `403`, as before.
- A hook that throws is now a `403` denial instead of an unhandled error.
- A hook that already answered the request (a redirect, a body) still keeps its answer — now on API
  requests too when it queued a body, not only when it set `location`.

Only `true` or `allowed: true` passes: a decision object is truthy, and the guard never tests the raw
value, so `{ allowed: false }` denies. This makes it safe for `@adonis-agora/authz`'s
`authorizeByRoles` to return decisions.

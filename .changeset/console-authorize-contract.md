---
'@adonis-agora/durable': major
---

The console's `authorize` option takes the shared `@adonis-agora` console contract (`ConsoleAuthorize`), the same one every Agora console accepts. Besides an inline function, it now accepts an authorizer class (built by the container, so `@inject()` works) or a lazy import of one:

```ts
authorize: (ctx) => ctx.auth.user?.isAdmin === true,
authorize: ConsoleAccess,
authorize: () => import('#policies/console_access'),
```

`authorize` may also return `{ redirectTo: '/login' }`: a page navigation is redirected there (`302`), an API call gets `401`. The `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` types are exported from `@adonis-agora/durable/dashboard`.

The default is unchanged: with no `authorize`, the console still requires `DURABLE_DASHBOARD_TOKEN` (or `dashboardAuth`, or `allowUnauthenticated: true`).

`resolveConfig(...).authorize` and `normalizeAuthorizeResult` now return the normalized decision (`{ allowed: true }` or `{ allowed: false, reason, redirectTo? }`) instead of the raw value.

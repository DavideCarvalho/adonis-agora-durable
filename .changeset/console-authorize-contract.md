---
'@adonis-agora/durable': major
'@adonis-agora/durable-dashboard': major
---

The console's access works like every other `@adonis-agora` console.

**`authorize` takes the shared contract** (`ConsoleAuthorize`): an inline function, an authorizer class (built by the container, so `@inject()` works) or a lazy import of one. It may return `{ redirectTo: '/login' }`: a page navigation is redirected there (`302`), an API call gets `401 { error: 'unauthenticated', redirectTo }`.

```ts
authorize: (ctx) => ctx.auth.user?.isAdmin === true,
authorize: ConsoleAccess,
authorize: () => import('#policies/console_access'),
```

**Without `authorize`, the console is open outside production and answers `403` to every request in production.** One warning is logged at boot: ``[@adonis-agora/durable] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/durable_dashboard.ts.``

**Token access is replaced by `authorizeByToken`.** `DURABLE_DASHBOARD_TOKEN`, the `x-durable-token` header, the `?token=` query param and `defaultAuthorize` are removed. For scripts:

```ts
import { authorizeByToken, defineConfig } from '@adonis-agora/durable/dashboard'

export default defineConfig({
  authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
})
```

It reads only `Authorization: Bearer <token>` and throws at config time when the token is empty.

**`dashboardAuth` and `allowUnauthenticated` are removed**, with the login page, `POST <path>/session`, `<path>/login`, `<path>/logout`, the session roles and their exports (`resolveDashboardAuth`, `performLogin`, `performSession`, `readSession`, `signSessionCookie`, `verifySessionCookie`, `SESSION_COOKIE_NAME`, `renderLoginPage`). Gate operators with your app's own sign-in in `authorize`. The console no longer shows a logout menu.

Denials are uniform: `403 { error: 'forbidden' }`, `401 { error: 'unauthenticated' }` (was `unauthorized`), and the access-denied page for page navigations. A throwing `authorize` is a `403`. The audit actor is `ctx.auth.user`'s `email`, `name` or `id`, `bearer` for a token caller, else `anonymous`.

`resolveConfig(config, { inProduction })` returns the resolved gate; `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass`, `ConsoleAuthorizeResult` and `authorizeByToken` are exported from `@adonis-agora/durable/dashboard`.

See the 1.0 migration guide for before/after examples.

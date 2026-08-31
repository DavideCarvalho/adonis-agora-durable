---
"@adonis-agora/durable": minor
---

Dashboard: a refused page navigation now gets a real page instead of `{"error":"forbidden"}`.

Opening the console without permission used to answer the browser with the same JSON the API
gets. It now serves a built-in access-denied page in the console's own visual language — the
status, a sentence explaining the refusal, a "Back to app" link and, when `dashboardAuth.login`
is configured, a "Sign in" button. The Mode-A-only "Open this console from your application."
notice uses the same page. API requests are unchanged (the SPA still relies on their JSON), and
an `authorize` hook that redirects still wins.

The page carries no inline `<script>`, so a nonce'd `script-src` CSP cannot break it; its inline
`<style>` takes `@adonisjs/shield`'s request nonce when one exists.

New `accessDenied` option on `config/durable_dashboard.ts` to customise it — an object
(`brand`, `title`, `message`, `homeHref`, `loginHref`, `accent`, labels) to tweak the built-in
page, or a function `(info, ctx) => html | void` to render it yourself or redirect.

Also: the built-in `dashboardAuth` login page no longer dies under a nonce'd CSP. It is now a real
HTML form that works without JavaScript — a form submit is answered with a redirect (to the page
the operator came from, or back to the form with the error shown) while the page's own `fetch`
keeps getting JSON — and its inline script/style carry `@adonisjs/shield`'s request nonce.
`renderLoginPage` takes an optional `{ nonce, error, returnTo }`.

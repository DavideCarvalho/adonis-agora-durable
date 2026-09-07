---
'@adonis-agora/durable': minor
---

Security wave for the console and the multi-tenant trust boundary.

**⚠️ Behavior change — the console now fails closed everywhere.** The default `authorize` guard no
longer opens the dashboard outside `NODE_ENV=production`: it requires `DURABLE_DASHBOARD_TOKEN` in
every environment, denying all requests when the var is unset. That old branch left dev boxes,
staging, and any deployment with an unset/misspelled `NODE_ENV` serving an unauthenticated console
whose destructive endpoints (bulk cancel-with-compensation on an empty filter, fix-and-replay with
arbitrary input) a malicious page could fire as simple cross-origin POSTs. **Migration:** configure
`dashboardAuth`, set `DURABLE_DASHBOARD_TOKEN` / your own `authorize`, or — for local development
only — spell out `allowUnauthenticated: true` (it warns at boot). When `dashboardAuth` is
configured, the session guard is the gate and the default token guard steps aside.

Also in this wave:

- **Cross-site rejection**: browser-originated cross-site mutating requests (by `Sec-Fetch-Site`,
  else `Origin` vs `Host`) get a 403 before any handler — CSRF defense-in-depth over the Lax
  session cookie. Non-browser clients are unaffected.
- **Session roles + audit**: a `dashboardAuth` session with a NON-EMPTY `roles` list must include
  `operator`/`admin` to hit mutating routes (empty list keeps full access — back-compat). Every
  mutating attempt is audited (actor, method, path) via the app logger or a config `audit` hook.
- **Payload caps**: fix-and-replay input and signal/update/task bodies are capped at 1 MiB (413).
- **Open-redirect fix**: `sanitizeReturnTo` now rejects backslash variants (`/\evil.com` — browsers
  normalize `\` to `/`).
- **Query-string token restricted to GET**: `?token=` exists only for the SSE live-tail
  (`EventSource` cannot set headers); it no longer authorizes mutating routes.
- **Session hardening**: `Secure` cookie forced in production even behind a proxy without
  trustProxy; login/session-mint endpoints rate-limited (10/min per address); `POST /logout` added
  alongside the GET.
- **500s stop leaking**: handler failures return a generic body; the detail (driver messages,
  stacks) goes to the app logger.
- **SSE budget**: per-instance (100) and per-address (10) caps on open event streams, plus a 25s
  server heartbeat so dead clients are reaped instead of holding engine subscriptions forever.
- **Tenant trust boundary**: the run-request responder logs a LOUD warning when started without a
  `verifyTenant` (the wire tenant claim is then trusted verbatim); `signTenantToken` gains optional
  expiry (`{ ttlMs }`, signed into the claim so it can't be stripped) and `hmacTenantVerifier`
  accepts a secret list for two-step rotation — both additive, legacy tokens keep verifying.
- **Codec coverage made honest**: `CodecStateStore` documents that the default covers only
  `input`/`output`, and gains `{ coverage: 'extended' }` to also encode step events, errors and
  heartbeat progress (fresh tables / self-detecting codecs only — see the docs). It also forwards
  `recordStepHeartbeat` now (wrapping a store with a codec used to silently drop persisted step
  liveness). New dashboard `redact` config hooks strip PII from the serialized run/checkpoint
  shapes the console renders.
- **LIKE escaping**: tag values and picker search needles containing `%`/`_` now match literally in
  the Lucid store instead of widening into patterns (the conformance suite asserts it).

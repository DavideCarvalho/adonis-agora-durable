---
'@adonis-agora/durable': minor
---

`config/durable.ts` now accepts `webhookUrl`, `admission`, `traceparent` and `trackStepStart`.

All four existed only as `WorkflowEngineDeps`, reachable solely by constructing a `WorkflowEngine` by hand — so there was no supported way to configure a webhook callback URL or a fleet-wide flow-control backend from an AdonisJS app, and passing them in `defineConfig({ ... })` was an excess-property error (or, once cast away, a silent no-op). The provider now reads and forwards each one:

- `webhookUrl: (token) => string` — populates the `url` on the object `ctx.webhook()` returns.
- `admission: AdmissionBackend | AdmissionFactory` — a ready backend, or a lazy thunk built with the new `admissions` factory namespace. `admissions.redis({ connection })` resolves an `@adonisjs/redis` connection by name and makes every `{ queue }` concurrency/rate cap fleet-wide instead of per-pod, importing the peer dependency only when selected.
- `traceparent: () => string | undefined` — an explicit builder wins over the `@adonis-agora/diagnostics-otel` global slot the provider already consumed, so a tracer durable does not know about can be bridged.
- `trackStepStart: boolean` — turn off the extra in-flight `running` checkpoint on hot paths with many short local steps.

---
'@adonis-agora/durable': minor
---

A control plane is now the one place every tenant's workflow lifecycle is recorded. Its diagnostics bridge stamps each event of a tenant's run, step events included, with `app` (the tenant's partition) and emits it in the run's trace (`runTraceId(runId)`); on a control plane the provider also registers the tagging Telescope watcher, which tags those entries `app:<partition>` next to `lib:durable`. A tenant pod still emits no lifecycle events of its own, and now runs each step and workflow turn in its run's trace when Telescope is loaded, so what it records inside a step joins the control plane's entries on `trace:<id>`. Every `durable.*` Telescope data provider takes `{ app }` to show one tenant. Standalone apps are unchanged.

The control plane passes the tenant on the diagnostics envelope (`emit(…, { app })`, `@adonis-agora/diagnostics` 1.0.0-rc.6+), and fills in the run's partition as `namespace` on the step events it forwards; the tagging watcher tags `app:` from the envelope first. The console's `authorize` may return `apps: '*' | string[]` (the shape every Agora console takes): with a list, listings, counts, namespace filters, run reads, live tail, every action, worker health and schedules are limited to those apps.

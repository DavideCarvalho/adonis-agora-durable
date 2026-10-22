---
"@adonis-agora/durable": minor
"@adonis-agora/durable-dashboard": patch
---

onError and allSettled follow-ups: retrying a run whose failure was handed off runs its body again (the previous handoff is retired as `onError:retried:<id>`; handler runs are `<runId>.onError.<attempt>`, handoff checkpoints sit at seq 1,000,000,000 and up). `FatalError(message, code?, details?)`: `code`/`details` reach the run's error, an onError handler, `allSettled` rejected items and a failed `ctx.child`'s `FatalError`. A handed-off run is tagged `onError:<code>` and emits `run.routed`. `engine.unservedOnErrorRoutes()`, and a boot warning from the provider.

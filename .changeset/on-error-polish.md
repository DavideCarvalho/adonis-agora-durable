---
"@adonis-agora/durable": minor
"@adonis-agora/durable-dashboard": patch
---

onError polish: `collectMetrics` and `attachDurableMetrics` count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`), and the OTel bridge records them as span events. The dashboard shows a failure's `code` and `details`. The boot warning for an unserved onError route rechecks after 30s. A retry drops the run's `onError:<code>` tag. The Lucid store's `listCheckpointsByNamePrefix` escapes `_` / `%`, like its `listSignalWaiters` already did.

---
'@adonis-agora/durable': patch
---

A remote workflow run awaiting a dispatched turn's decision now honours `cancel(id, { compensate: true })`: it settles `cancelled` (a remote workflow has no engine-side saga compensations) instead of the cancel being swallowed by the turn-in-flight hold, and the late decision is dropped. `requeue` and `cancel` clear the run's `awaitingDecisionTaskId`. `DURABLE_SCHEMA_REVISION` is 3 (the `awaiting_decision_task_id` column), so every Lucid database runs the full schema check once on its next boot.

A remote workflow run whose turn was lost with a call still in flight (an inline `advance` that hit `remoteAdvanceSilenceMs`, or a replica that died applying a decision) is now re-driven by the timer pass about a second after orphan recovery parks it, instead of after the whole `reconcileMs` window; the in-flight call is not dispatched again. `ProxyRunGateway.runFacets` degrades against an older control plane: it counts the cells from `runValueFacets`, or from `listRuns` on one older still, instead of rejecting with `unsupported-request`.

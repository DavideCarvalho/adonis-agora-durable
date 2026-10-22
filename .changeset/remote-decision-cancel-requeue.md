---
'@adonis-agora/durable': patch
---

A remote workflow run awaiting a dispatched turn's decision now honours `cancel(id, { compensate: true })`: it settles `cancelled` (a remote workflow has no engine-side saga compensations) instead of the cancel being swallowed by the turn-in-flight hold, and the late decision is dropped. `requeue` and `cancel` clear the run's `awaitingDecisionTaskId`. `DURABLE_SCHEMA_REVISION` is 3 (the `awaiting_decision_task_id` column), so every Lucid database runs the full schema check once on its next boot.

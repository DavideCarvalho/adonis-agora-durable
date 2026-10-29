---
'@adonis-agora/durable': minor
---

A run whose `workflow@version` is registered on no instance (the workflow was renamed or deleted with runs in flight) no longer loops forever. Once it has been due for `unregisteredWorkflowGraceMs` (default 24h, counted from its `wakeAt` for a parked run), it moves to `dead` with a `workflow_not_registered` error, fires `onDead` and reaches the dead-letter workflow. Before, every poll tick skipped it and logged `is not registered — keep the prior version deployed` again. A rolling deploy's skew, where the pod on the prior version picks the run up within seconds, is unaffected. Set `unregisteredWorkflowGraceMs: 0` to keep the old skip-forever behavior.

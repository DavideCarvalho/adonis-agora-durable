---
'@adonis-agora/durable': patch
---

Recovery, cancellation and shutdown fixes:

- **Orphan recovery no longer dead-letters a run whose remote step is in flight.** A run found `running` with a free lease while a remote step is still `pending` on the transport is parked `suspended` on the step's deadline or the `reconcileMs` wake, and `recoveryAttempts` is not counted. Before, every pass counted an attempt, so a slow step could reach `maxRecoveryAttempts` and be moved to `dead` while its worker was still busy.
- **`requeue` resets `recoveryAttempts` to 0 when it resurrects a `failed`/`dead` run**, so a retried dead-letter isn't killed again by the next recovery pass. Requeueing a live run keeps its count.
- **One bad run no longer aborts a recovery, timer or pending sweep.** It is logged with its id and `workflow@version` and skipped, and the rest of the batch runs. A lease taken while drain began is handed back instead of starting the run.
- **A compensating cancel is never lost when the turn doesn't suspend.** If the turn running when `cancel(runId, { compensate: true })` lands returns, throws or continues-as-new, it now runs the compensations and settles `cancelled`, instead of completing, failing or forking the next run. This also works when that turn runs on another instance (through the durable `cancel:<id>` marker).
- **A failed turn no longer causes an unhandled rejection.** The in-flight bookkeeping used `p.finally(...)`, which re-rejected.
- **Shutdown stays within one `drainTimeoutMs`.** `engine.beginDrain(spentMs)` reports wait already spent and it is deducted from `drain()`, including a drain already waiting. Non-finite or negative values are ignored. The worker loop (`durable:work`, embedded worker) charges the drain for the time spent waiting for its in-flight tick, and stops waiting for a tick that outlives the whole budget.
- **`reconcileMs` and `blockedPollMs` are now `config/durable.ts` fields.** A non-finite or negative `reconcileMs`, or a non-finite or sub-1 `blockedPollMs`, falls back to the default instead of silently disabling the reconcile net or hot-looping blocked runs.

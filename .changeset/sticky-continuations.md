---
'@adonis-agora/durable': minor
---

Sticky continuations: a workflow body parked on dispatched `ctx.step` calls stays in memory and continues when the step's result lands on the same instance, instead of replaying from the top over the run's history. Bounded by `stickyRuns` (default 2000, `0` turns it off) and `stickyIdleMs` (default 5 min); a run moved on by another instance, a cancel, an eviction, a classic suspension (sleep, signal, child) or a primitive called while the body is detached falls back to a replay.

Fewer round trips per dispatched step, through new optional `StateStore` methods, implemented by the Lucid store (one statement each on Postgres): `settleResultsIfPending` (settle results and read the rows and the run back), `tryLockRunAndGet` (take the lease and read the run) and `insertCheckpointIfAbsent` (a first dispatch's `pending` row without reading the position first). The in-memory store has them opt-in (`new InMemoryStateStore({ roundTripMethods: true })`).

Also fixes a resurrection race: a run's first turn moves it `pending` → `running` with a compare-and-set, so a cancel landing between the run's read and its start is no longer overwritten.

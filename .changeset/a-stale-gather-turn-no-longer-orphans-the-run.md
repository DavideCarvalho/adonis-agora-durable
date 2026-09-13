---
'@adonis-agora/durable': patch
---

A stale gather turn no longer orphans its run

A turn is computed from a SNAPSHOT of history, and the ops it declares can all have settled while its decision was in flight. The canonical case is a `gather_calls` fan-out whose last call lands while the turn holding the run lease is still deciding: that call's `resume` reaches `execute`, finds the lease contended and returns silently — no retry, no reschedule — so its wake is spent for nothing, and the decision then parks the run on a `call` that is already complete.

Every call settled, nothing holding the lease, no wake scheduled: the run sits `suspended` until the `reconcileMs` orphan sweep re-drives it, minutes later.

After a turn parks, the engine now checks whether any `call` it parked on has already settled, and re-drives the run if so. Ported from the NestJS sibling, where the same shape stalled 23% of a seven-call fan-out's runs for 301 seconds each.

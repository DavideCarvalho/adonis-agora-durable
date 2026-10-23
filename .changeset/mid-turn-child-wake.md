---
'@adonis-agora/durable': patch
---

A child that finishes while its parent's turn still holds the parent's lease no longer leaves the parent waiting for its reconcile wake.

- `ctx.child` writes the child's waiter and `running` placeholder together, before it starts the child (as `ctx.all` already did). The placeholder used to be written after the start, so a child that finished in between had its completion overwritten by the placeholder. Its waiter was already consumed by then, and its wake had been refused by the parent's lease, so nothing resumed the parent until `reconcileMs`.
- A wake refused because another instance holds the run's lease is looked at again while the run is still `running` under that lease (the holder's turn is still executing), instead of being dropped on the first look. It resumes the run once the lease is free and the run is `suspended` (or `blocked`, waiting for a capable worker), whether or not the holder's own post-turn re-check ran.
- The run-dispatch contract (`runRunDispatchContract`) and the new `assertMidTurnChildWake` kit cover `ctx.all`, `ctx.allSettled` and `ctx.child` on every transport.

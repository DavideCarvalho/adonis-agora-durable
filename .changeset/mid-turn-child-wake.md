---
'@adonis-agora/durable': patch
---

A child that finishes while its parent's turn still holds the parent's lease no longer leaves the parent waiting for its reconcile wake.

- `ctx.child` writes the child's waiter and `running` placeholder together, before it starts the child (as `ctx.all` already did). The placeholder used to be written after the start, so a child that finished in between had its completion overwritten by the placeholder, with its waiter already consumed and its wake refused by the parent's lease.
- A wake refused because another instance holds the run's lease is now kept on the run row: it stamps a new `wakeRequestedAt` (`wake_requested_at` column, added by `autoSchema` or the migration; schema revision 4). The holder lets go of the lease only while no stamp is there (new optional `StateStore.releaseRunLockUnlessWakeRequested`, in the Lucid, in-memory and codec stores) and otherwise runs another turn; a `suspended` run carrying the stamp is due for the timer poll (`listDueTimers`). The request no longer depends on the refused instance staying up, and there is no cap on how long the holder may keep the lease. The refused instance still looks again in memory (no longer capped at 30 looks), as the fast path, until a turn served the request.
- The state-store contract has cases for the stamp, `listDueTimers` and the conditional release. The run-dispatch contract and the new `assertMidTurnChildWake` / `assertSingleInstanceSingletonFan` kits cover `ctx.all`, `ctx.allSettled` and `ctx.child` (holder skipping its re-check, keeping the lease past 30 looks, a store that cannot keep the stamp, the refused instance and the holder going down), and a one-instance `singleton` parent with search attributes and remote steps around its fan, on every transport.

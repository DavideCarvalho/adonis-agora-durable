---
'@adonis-agora/durable': patch
---

An instance restarted under the same stable `instanceId` (a pod name) after a `SIGKILL`/OOM kill now reclaims the `running` runs its previous process left leased to that id at once, instead of waiting up to `leaseMs` for those leases to expire.

- For the first `leaseMs` after boot, `recoverIncomplete()` also lists the runs leased to its own `instanceId`. It reclaims one only when nothing in the process is executing it (no execution in its run gate, no tracked execution lease) and the lease was written before the engine started. The stale lease is released inside the run's in-process gate, so a resume landing at the same moment queues behind it, and the run then goes through normal orphan recovery (it counts a `recoveryAttempts`). A live instance never reclaims a run it is executing. Other instances still wait for the lease to expire.
- `StateStore.listOrphanedRuns(nowMs, limit, namespace?, owner?)` gains an optional `owner`: also return `running` runs whose lease is held by that owner. Implemented by the Lucid store, the in-memory store and `CodecStateStore` (passthrough, and the in-process fallback). A custom store that ignores it keeps the expiry-only behaviour. The state-store conformance suite has a case for it.

This needs `instanceId` to be unique per live process, as the docs already required: two live processes sharing an id read each other's leases as their own.

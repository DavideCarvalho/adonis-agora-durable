---
'@adonis-agora/durable': minor
---

Singleton admission is now an atomic, durable store claim. The gate used to re-scan the key's `running`/`suspended` runs by `(createdAt, id)` on every check, so two replicas could admit past `limit`, an older run picked up after a younger one was admitted alongside it, a same-millisecond start whose id sorted first displaced the holder, and a denial landing after a concurrent `cancel` wrote the run back to `suspended` (resurrecting it).

- New optional `StateStore.tryAdmitSingleton(runId, tag, workflow, limit, retryWakeAt?)`. In one transaction it reads the key's active (`pending`/`running`/`suspended`/`blocked`) runs and claims a slot for the oldest waiter, or parks a denied run `suspended` on its retry timer (never a run that is no longer active). The Lucid store locks the rows with `SELECT … FOR UPDATE` on Postgres/MySQL and takes the write lock first on SQLite. The in-memory and `CodecStateStore` stores support it too.
- A slot is recorded on the run as the reserved tag `durable:singleton:admitted`. It is held through sleeps, signals, `blocked`, recovery on another instance and an expired lease, and released by the terminal settle (`updateRun`/`updateRunIf` drop it). Fresh runs can't supply or inherit the tag (`retryWithInput` copies tags), and `requeue` drops a stale one.
- Notify-on-release no longer wakes a sleeping holder. `maxQueueDepth` also counts `blocked` runs.
- The decision helpers `singletonAdmissionTags`, `singletonAdmissionDenialPatch`, `SINGLETON_ADMITTED_TAG` and `SINGLETON_ACTIVE_STATUSES` are exported for custom stores, and the state-store conformance suite covers the claim.

No schema migration. **Breaking for custom stores:** a store without `tryAdmitSingleton` can't run singleton workflows, and their `start` throws before creating the run. Upgrade every worker together, because runs already in flight carry no admission tag (they compete as ordinary FIFO waiters on their next check).

---
"@adonis-agora/durable": patch
---

Fix a cross-instance race in the durable step lease renewal: a worker heartbeat renewing a suspended remote step's lease read the checkpoint and then wrote the whole row back unconditionally, so a result (or a lost-dispatch re-dispatch) landing on another pod in between could be undone — a `completed` step put back to `pending` and run a second time, or a re-dispatch's `attempts` and deadline rolled back. The renewal is now a compare-and-set through the new optional `StateStore.renewCheckpointLease` (a single guarded `UPDATE ... WHERE status = 'pending' AND wake_at = <read value>` on the Lucid store, implemented by the in-memory store and forwarded by `CodecStateStore`); stores without it fall back to `saveCheckpointIfPending`, which never touches a settled row.

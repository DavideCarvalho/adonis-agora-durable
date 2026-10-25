---
"@adonis-agora/durable": minor
---

Wide step fans settle in bulk, and child completions no parent will consume are no longer buffered forever.

- The `bullmq`, `queue` and `db` transports hand the engine at least 512 step results at once per instance (`resultConcurrency` only raises it). The `db` transport claims result rows 256 a round and deletes each round's in one statement.
- The engine settles one run's results in hand as a batch: one batched checkpoint read (`StateStore.getCheckpoints`), one conditional write, and one resume. It skips the fan's barrier count while more of the same fan's results are queued behind the batch, and two instances that both see a wave settle run one turn for it, not two. A turn that runs while a fan is out reads no per-step checkpoint.
- A fan's dispatching turn writes its pending checkpoints in one call (`StateStore.saveCheckpoints`) and sends its tasks in bulk (`Transport.dispatchMany`: BullMQ `addBulk`, multi-row inserts on `db`, `pushManyOn` on `queue`), falling back to one by one.
- The Lucid store's `saveCheckpointsIfPending` is set-based (one locked `SELECT`, then multi-row upserts), and it implements `getCheckpoints` and `saveCheckpoints`. On a 20,000-step fan over 6 instances on MySQL, the fan settles in 29s instead of 155s.
- A child's completion is buffered only when a live parent can consume it: not for a root run, a gone, `completed` or `cancelled` parent, or a parent that already holds the outcome (including a folded fan). A bounded background sweep deletes the orphaned `child:` rows already buffered, through the new optional `StateStore.listBufferedSignals` / `deleteBufferedSignals`.

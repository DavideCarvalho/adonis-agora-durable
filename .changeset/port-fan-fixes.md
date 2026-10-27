---
'@adonis-agora/durable': patch
---

Three fan fixes from the aviary engine and BullMQ transport:

- **A wide step fan is written and dispatched in rounds of 2,000.** A round's tasks go out once its checkpoints commit, while the next round is written, so workers start on a fan after its first round instead of after every checkpoint of it.
- **An adaptive worker's limit drops a quarter per queuing tick (at least one slot)** instead of to `limit × gradient`. One slow moment in the 100-step window no longer drops a worker to one or two slots for ten ticks; queuing that persists still halves the limit in under three ticks.
- **A BullMQ worker publishes step results in batches while an engine reads them.** Results that finish while one batch is being published go out together in the next (up to 256), on a new `<P>-results-batch` queue that only batch-reading engines consume. A worker sends batches only while BullMQ's worker list shows such a consumer (rechecked every 5 s); otherwise, and for older engines or the Python worker, results stay one job each on `<P>-results`. A 5,000-step fan: 66 → 39 Redis commands a step, and 5.8 s → 4.0 s against a Redis with a fifth of a core. `QueueLike.getWorkersCount` is optional; custom deps without it keep one result per job.

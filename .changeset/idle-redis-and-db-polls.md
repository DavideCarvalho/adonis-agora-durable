---
"@adonis-agora/durable": patch
---

Fewer Redis and database round trips from an idle fleet:

- The worker loop reads settled runs that still owe a lifecycle event once every 10 s instead of on every 1 s tick. That read filters runs by tag, which no index serves, so on a large runs table it was a scan per second per process. `engine.sweepLifecycleEvents(now, limit, { owed: false })` does only the per-tick part (registry row, subscription snapshot, run waiters); calling it without the option is unchanged.
- `transports.bullmq({ drainDelay })`: how long (seconds) a worker blocks on an empty queue before polling it again. Default `30` (BullMQ's own default is `5`). New and delayed jobs still wake the worker at once, so only idle queues are polled less often.

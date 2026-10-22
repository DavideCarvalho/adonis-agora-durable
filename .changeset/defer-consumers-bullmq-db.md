---
'@adonis-agora/durable': minor
---

`consumers` (`'auto'` / `'never'` / `'always'`) now works on the `bullmq` and `db` transports, not only `queue`.

Both started consuming in every process that booted them. A `node ace` command or REPL could claim step jobs and die holding them, and could take results meant for the long-lived engine — the bug the `queue` transport fixed in 0.17. With `bullmq` a claimed job stays held until BullMQ's stall check; with `db`, until the row lease expires.

They now implement `deferConsumers()` / `startConsumers()`:

- `bullmq` creates no `Worker` until consumption starts: the task, results, decisions, step-events, start-run and run-request workers. Their `failed` bridges and adaptive `concurrency` assignments are replayed onto the real workers. Pub/sub subscriptions (heartbeats, run replies, tenant events) are broadcast and still start right away.
- `db` parks its task, result, heartbeat and control poll loops.

With the default `'auto'`, console and REPL processes are pure producers on every broker transport, and `durable:work` re-enables consumption for itself.

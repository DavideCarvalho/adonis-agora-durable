---
'@adonis-agora/durable': minor
---

The BullMQ transport no longer walks the Redis keyspace with `SCAN` to find workers. Workers now write their liveness and handshake descriptors to one hash per routing token (`<P>-workers:heartbeats:<token>`, `<P>-workers:descriptors:<token>`), listed in `<P>-workers:tokens`, and the engine reads them with one `HGETALL` per token. Workers still write the per-instance `<P>-worker-heartbeat:*` / `<P>-worker-descriptor:*` keys, so older engines keep seeing them. To see workers that write only those keys (older versions, the NestJS and Python SDKs), the engine walks them once, shared by the whole process, at most every `workerRegistry.legacyScanIntervalMs` (60s). A cached heartbeat read is now reused for 5s instead of 1s, and a worker that shuts down cleanly removes its entries.

New `transports.bullmq({ workerRegistry: { legacyScan, legacyScanIntervalMs, connection } })`: set `legacyScan: false` once every worker runs this version, and pass `connection` to keep the registry hashes on another Redis db.

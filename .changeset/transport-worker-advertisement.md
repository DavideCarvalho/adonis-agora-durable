---
"@adonis-agora/durable": minor
---

The `db` and `eventEmitter` transports carry the worker advertisement (design §7.2): `createDescriptorRedis()`, `listWorkerDescriptors(token)` and `listWorkerGroups()`, so a thin worker on them is visible to capability-aware routing, and a workflow served by convention is routed by the onError its workers announce. The `db` transport keeps it in a new `durable_transport_worker_keys` table (created by `autoCreate`, or by the new published migration `create_durable_transport_worker_keys`), with reads reused for `workerKeysCacheMs` (default 5s). The `eventEmitter` transport keeps it in memory, shared by every transport over the same emitter. The `queue` transport has no such store: its queues are point-to-point.

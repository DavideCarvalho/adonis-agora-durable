---
'@adonis-agora/durable': patch
---

Make `engine.workerHealth()` (the dashboard's `/workers`, `/health` and `/metrics`) cheap on the BullMQ transport: one shared, single-flight walk of the worker-heartbeat keyspace (reused for 1s) now serves `listWorkerGroups`, every `groupHealth` and `readAllWorkerHeartbeats`, instead of one full-keyspace SCAN walk per call per group; worker-key SCANs use `COUNT 1000`; job counts run alongside the heartbeat read; the transport pool queries its transports in parallel; and the queue/db transports' cached worker-key read coalesces concurrent misses. Response shapes, Redis keys and config are unchanged.

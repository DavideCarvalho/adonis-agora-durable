---
"@adonis-agora/durable": minor
---

The `queue` transport carries the worker advertisement: workers' descriptors and heartbeats go to a `WorkerKeyStore` beside the queues — by default the app database's `durable_transport_worker_keys` table (the one the db transport uses), created on first use — and `listWorkerDescriptors` / `listWorkerGroups` read them back, so capability routing, convention workflows and announced onError routes work on it. New options `workerKeys` (any `WorkerKeyStore`, or `false`), `workerKeysConnection`, `workerKeysCacheMs`. With no database the transport advertises nothing, as before.

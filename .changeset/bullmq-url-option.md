---
"@adonis-agora/durable": patch
---

A `bullmq` connection given as options with a `url` (`{ url: 'redis://…' }`) now reaches that Redis
from every client. BullMQ read the URL for the queues, but ioredis ignores `url`, so the pub/sub and
heartbeat clients connected to 127.0.0.1:6379 instead: step heartbeats, run replies and tenant
events were lost, or went to another Redis. Keys set beside the `url` (a `tls` with a CA, a `db`) are kept over the ones the URL implies.

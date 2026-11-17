---
'@adonis-agora/durable-dashboard': minor
---

The Workers page understands grouped BullMQ task queues: a partition whose handlers share one queue shows a "shared queue" badge and counts that queue's depth once, exact even when the per-handler split was sampled, and a starved handler's sampled depth reads `≥N`.

---
'@adonis-agora/durable': minor
---

New `transports.bullmq({ stalledInterval })`, passed to every BullMQ `Worker`: how often (ms) each worker checks its queue for jobs of a crashed worker. The default stays BullMQ's 30s. The check is about half of an idle queue's Redis commands, so a fleet with many step queues can raise it (120s saved about 0.17 commands per second per queue) at the cost of a crashed worker's in-flight steps waiting up to that long, plus the 30s job lock, before another worker picks them up. `createBullMQDeps` takes it as a new optional fourth argument.

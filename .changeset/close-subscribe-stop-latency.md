---
'@adonis-agora/durable': patch
---

Shutdown fixes: no unhandled "Connection is closed." when closing while pub/sub subscriptions are still connecting (BullMQ transport, Redis control plane, Redis admission backend: a subscribe rejection is ignored once closing has begun, otherwise logged); `BullMQTransport.close()` now closes workers and queues concurrently under a new `closeTimeoutMs` bound (default 5000, `0` skips the wait) and always disconnects; and a stop requested mid-tick (`WorkflowEngine.requestStop()`, called by the worker loop) now stops runPending/recovery/timer sweeps from locking or starting further runs, so shutdown no longer waits out a whole backlog tick.

---
'@adonis-agora/durable': minor
---

Shutdown fixes. No unhandled "Connection is closed." when closing while pub/sub subscriptions are still connecting (BullMQ transport, Redis control plane, Redis admission backend): the rejection is ignored once closing has begun, otherwise sent to the transport's `onError` or logged. `BullMQTransport.close()` closes workers first, then queues, under one `closeTimeoutMs` deadline (default 5000, `0` skips the wait; also available on `transports.bullmq()`, which now forwards `onError` too) and always disconnects, so an in-flight step can still publish its result. New `WorkflowEngine.beginDrain()` (called by `drain()` and by the worker loop the moment a stop is requested) sets `draining`: recovery, timer, pending, schedule and timeout sweeps stop locking or starting runs mid-tick, and `runOne` refuses broker-delivered runs.

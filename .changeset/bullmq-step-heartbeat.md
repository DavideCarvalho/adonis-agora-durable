---
'@adonis-agora/durable': patch
---

Fix(bullmq): on the BullMQ transport, steps with a `timeoutMs` no longer false-timeout and get re-dispatched while still running. `#runTask` never passed the heartbeat callback to `runStepHandler`, even though `heartbeat()` and `onHeartbeat` were fully wired — so a healthy, actively-progressing long step emitted no beats, `engine.awaitWithHeartbeat` never rearmed its liveness window, and at `timeoutMs` the engine concluded the worker was dead and re-dispatched the same `stepId` while the original worker was still executing it. The transport now emits step heartbeats the engine's liveness window depends on, matching the `db` and `queue` transports.

---
"@adonis-agora/durable": patch
---

The db and queue transports no longer hand work to a handler that they claimed after shutdown began. A poll already in flight when `stop()`/`close()` was called could claim a row or pop a job that arrived meanwhile and run it while the pod was going away (or after a run-queue consumer's own `stop()` resolved). Every claiming loop now gives back what it claimed once the transport (or the loop) is stopping: the db transport's results, heartbeat, control and message loops (decisions, step events, start-run, run requests and replies, tenant events) and its run queue on a transport stop, and every queue-transport loop (tasks, results, heartbeats, control, run queue and the tenant protocol). The db task loop already did.

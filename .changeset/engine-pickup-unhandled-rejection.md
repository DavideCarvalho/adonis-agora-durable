---
'@adonis-agora/durable': patch
---

A run whose turn fails on a store error no longer raises an unhandled rejection, `drain()` now waits for an in-process pickup that has not started executing yet, the `db` transport never runs more rows than its live adaptive limit, and worker heartbeats no longer pile up writes behind a slow key store.

- The engine dropped a finished execution from its in-flight set with a `finally` chain nothing awaited, so a turn whose store write failed (a lost connection, a missing table) was handled by its caller and ALSO surfaced as a process-level unhandled rejection — fatal under Node's default `--unhandled-rejections=throw`.
- The default in-process dispatcher's pickup (lease, read, then execute) is tracked from the moment of dispatch, so `drain()` can no longer return while it is about to write onto a connection being closed. A failed pickup is reported with an `[adonis-durable]` warning instead of being swallowed silently; the run is retried by the pending-run poll or recovery, as before.
- The `db` transport sized each claim round from the adaptive limit read before the claim's round trips. When the RAM brake lowered the limit during a round, every row the round won still ran. Rows beyond the live limit are now handed back before running.
- The `db` and `queue` transports' worker heartbeat no longer starts a liveness-key write while the previous one for the same routing token is still in flight. A key store slower than `workerHeartbeatIntervalMs` used to pile up writes without bound, each holding a pool connection that the claim loop and `groupHealth` then waited behind.

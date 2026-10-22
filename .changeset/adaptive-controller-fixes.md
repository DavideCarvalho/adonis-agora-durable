---
'@adonis-agora/durable': patch
---

BullMQ adaptive concurrency controller fixes, mirrored from `@dudousxd/durable-worker`:

- The worker heartbeat's `throughputPerMin` is a rate over the trailing minute. It decays while a worker is idle and reads 0 once a minute passes with no completed step, instead of reporting the last burst's rate forever.
- With a fixed `concurrency` the controller no longer runs its control-loop timer. The limit stays the fixed value, and the heartbeat samples CPU itself, at most once every 2s, so `cpuPct` is still reported.
- `AdaptiveController` takes optional `readCpuUsage` and `readCpuCount` readers (defaults `process.cpuUsage()` and `os.cpus().length`), so the CPU ceiling can be driven in tests.

---
'@adonis-agora/durable': minor
---

`transports.bullmq({ concurrency: 'adaptive' })`: workers size their own step concurrency, the same controller as aviary's

- **`concurrency` takes `'adaptive'` or `{ mode: 'adaptive', min, max, start, tickMs, ramCeilingPct, cpuCeilingPct }`.** Every `tickMs` the worker sets the `concurrency` of all its task queues at once: up by one while steps saturate the limit at a steady latency, down by the latency gradient when they queue, down by one on a step error rate above 20%, a stall or the CPU ceiling, and down 20% when RSS reaches `ramCeilingPct` of the memory limit (cgroup v2, then v1, then host total). A task queue registered later starts at the current limit. Only step durations feed the latency window; workflow turns count as in-flight work and progress.
- Defaults: `min` 1, `max` 32, `start` `min`, `tickMs` 2000, `ramCeilingPct` 85, `cpuCeilingPct` off. A non-finite or out-of-range field falls back to its default, as in aviary.
- A number still pins the limit (default 1, a non-finite or sub-1 value falls back to 1). In adaptive mode the decisions, step-events, start-run and run-request consumers run at 1.
- The worker heartbeat's `status` now comes from the controller in both modes: the per-queue limit (not the number of task queues), in-flight work, RSS against the memory limit, CPU, step throughput and p95, and the last adjustment with its reason. Throughput and p95 count steps only, and throughput reads 0 once the newest step completed over a minute ago.
- `AdaptiveController`, `resolveConcurrency`, `readMemoryLimitBytes` and the `ConcurrencyOption` types are exported.

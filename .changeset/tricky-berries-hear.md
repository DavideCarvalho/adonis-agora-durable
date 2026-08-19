---
'@adonis-agora/durable': minor
---

`transports.queue(...)` and `transports.db(...)` now forward the isolation and reclaim options their transports already supported.

Both factories silently dropped everything the underlying `QueueTransport` / `DbTransport` accepted beyond a handful of fields, so documented knobs were unreachable from `config/durable.ts`: there was no way to run two worker pools on one backend (`partition`), to segment a namespace explicitly, to tune the stalled-job reclaim sweep (`stalledCheckIntervalMs`, `stalledThresholdMs`, `maxStalledCount`), or to route poll-loop failures into the app logger (`onError`). All of them now pass through, and `group` is marked deprecated on both configs to match the transports, which route by handler name.

---
"@adonis-agora/durable": patch
---

Performance sweep, no API or behaviour change:

- The per-step heartbeat write throttle no longer resets wholesale past 1,024 entries (which a fleet with more steps in flight than that hit every few seconds, turning the throttle off); expired entries are dropped and the map is capped at 16,384, oldest first. The lease re-arm throttle and the admitted-queue fallback map are bounded the same way (the latter previously leaked when a result landed on another pod).
- Postgres: `durable_signal_waiters.token` and `durable_buffered_signals.token` get a `varchar_pattern_ops` index, so the `token LIKE 'prefix%'` reads (event publish, a fan's buffered child completions, the entity sweep) stop scanning the whole table under a non-`C` collation. Schema revision 5.
- Singleton admission reads only the columns its decision needs under `FOR UPDATE` (not every waiter's payloads); the `maxQueueDepth` check counts instead of loading runs.
- The console's tag/attribute pickers scan only `tags`/`search_attributes` instead of every run's payloads; column pickers are one grouped pass instead of a self semi-join.
- The stalled-run sweep reads only pending checkpoints; run-detail and fan-page polls read the run and its checkpoint buckets in one round trip; `/compat` reads each group's descriptors at once; `/metrics` reads worker health alongside the counts; Telescope widgets share concurrent identical reads.
- Redis admission `release` sends its HDEL and PUBLISH back to back (one round trip).

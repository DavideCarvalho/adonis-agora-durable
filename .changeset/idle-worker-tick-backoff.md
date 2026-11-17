---
'@adonis-agora/durable': minor
---

An idle worker loop now ticks less often: after a tick that finds nothing it waits 2s, 4s, then 5s between ticks (`--max-idle-interval` on `durable:work`, `worker.maxIdleIntervalMs` for the embedded loop, `maxIdleIntervalMs` on `runWorkerLoop`), and goes back to the regular tick as soon as there is work. It never waits past a known due time: before a longer wait it reads when the next timer, wake request or persisted schedule is due, and the next window of the config `schedules`. A run enqueued on another instance (control-plane nudge) ends the wait at once, and a run starting or finishing a turn in the process brings back the regular tick. An engine with neither a run queue nor a control plane keeps the fixed tick. Idle Postgres load per worker went from 5.3 to 1.7 statements per second.

New optional `StateStore.nextDueTimerAt(namespace?)` (the Lucid and in-memory stores implement it; a store without it keeps the fixed tick) and `engine.onIdleWake(listener)`.

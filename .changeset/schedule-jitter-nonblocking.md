---
'@adonis-agora/durable': patch
---

Schedule `jitter` no longer blocks the worker tick. `runSchedules` used to `sleep` each due schedule's jitter inside the tick, one schedule after another, so every other schedule and the rest of the tick (pending runs, timers, recovery) waited behind it. After a restart, with several jittered windows due at once, schedules fired many minutes late: about 7, then 5 minutes, on an app with 90–120 s jitters. Each window now gets its own fire time, up to `jitter` after the worker first sees it due, and a later tick starts it once that time has arrived. A window deferred past its interval still fires. Run ids and exactly-once are unchanged. The `sleep` option of `runSchedules` is deprecated and no longer called.

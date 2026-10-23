---
'@adonis-agora/durable': patch
---

Schedule jitter follow-ups: `runSchedules` documents that it must be called with the same `engine` object every time (deferred windows are remembered per engine), and it drops a schedule's jitter memo once the schedule no longer has a jitter.

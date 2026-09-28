---
'@adonis-agora/durable': minor
---

A persisted schedule can carry a **concurrency quota** (port of nestjs-durable#340): `engine.schedules.create/upsert({ …, concurrency: { key, limit, countStatuses? } })` applies it to every run the schedule starts, like `StartOptions.concurrency`. An over-limit window is skipped and recorded as the schedule's `lastError`; the schedule moves on to its next window.

---
'@adonis-agora/durable': minor
---

The `queue` transport now renews the claim of every job it is still working on, so a long step is never re-delivered and a dead worker's job is recovered in minutes instead of half an hour.

The transport drives the `@adonisjs/queue` adapter directly and bypassed the `Worker` class's heartbeat along with its stalled recovery, so a claim's `acquiredAt` was never refreshed: its age was the step's runtime. The stalled threshold therefore had to exceed the longest step — a 30-minute default that left a crashed worker's job unrecovered for 30 minutes, while a step that ran longer than the threshold was re-delivered and ran twice. The transport now calls `adapter.renewJobs` every half `stalledThresholdMs` for its in-flight claims (leases on `@adonisjs/queue` 0.7, job ids on 0.6), so a claim's age measures how long its worker has been silent.

- `stalledThresholdMs` defaults to 2 minutes when the adapter can renew (every `@adonisjs/queue` 0.6/0.7 driver), and keeps the 30-minute default on an adapter without `renewJobs`. An explicit value is unchanged.
- A renewal that finds a claim already re-delivered (the worker was silent past the threshold, e.g. a synchronous step blocked the event loop) is reported to `onError`, since the step may be running twice.
- Rolling upgrade: an old worker that does not renew can have a long step reclaimed by a new instance's 2-minute sweep. Durable steps are idempotent, so this is the usual at-least-once double run; pin `stalledThresholdMs` to the old value until every worker is upgraded if repeats are expensive.

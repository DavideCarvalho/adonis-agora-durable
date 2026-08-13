---
"@adonis-agora/durable": minor
---

`GET /runs` (the dashboard's runs list) now stamps `waiting` on a `suspended` run parked on a signal/webhook/child-await/breakpoint, resolved from one bulk `listSignalWaiters` scan — matching `@dudousxd/nestjs-durable-dashboard`'s list rows. Verified by running both dashboards side by side with live data: a run suspended on `ctx.waitForSignal` previously showed a generic "RUNNING" badge in the runs list (the underlying `listSignalWaiters` primitive existed on the store, but nothing wired it into the dashboard's list endpoint); it now shows "AWAITING / signal `<name>`" the same as the NestJS console. The single-run detail view was unaffected (it already derives this from the run's timeline).

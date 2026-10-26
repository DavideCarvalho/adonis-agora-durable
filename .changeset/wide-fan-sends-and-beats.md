---
"@adonis-agora/durable": patch
---

A wide step fan no longer slows down on its way out and while its steps run.

The `bullmq` and `queue` transports grouped a fan's tasks by queue by copying the group on every
task, so sending 150k steps took over a minute; it is linear now. The Lucid store's batched settle
grouped its rows the same way.

Every step's worker beats once when it picks the step up, and each beat was written to the step's
checkpoint at once: a 40k fan made 40k concurrent `UPDATE`s that took the store's connections from
the fan's results. Beats are now written one at a time, a newer beat of a step replaces its queued
one, and a step whose result arrives first never has its beat written. A 40k fan over BullMQ and
MySQL went from 46 s to 13 s.

With `remoteRedispatchMs` set, a fan's steps are written with their lease already stamped and the
run parks on it; a pickup beat on the instance that sent the fan no longer reads the step and
rewrites its lease. The same 40k fan went from 50 s to 14 s.

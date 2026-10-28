---
'@adonis-agora/durable': patch
---

perf(engine): settling a step result no longer costs an extra run write, and a crashed turn's re-dispatched steps no longer run twice on BullMQ.

- The owed-resume mark from the crash-recovery fix (a `suspended` run's timer pulled in to one lease
  before its step result is acknowledged) was one extra UPDATE of the run row per result — an indexed
  column, so never a cheap in-place write — and cost one-step workloads several percent of throughput. The
  acknowledgement now waits (at most three seconds) for the background resume instead: when the resumed
  turn ends first, as it almost always does, it has settled or re-parked the run itself and nothing is
  written. Only a resume that outlasts the wait, fails, or finds the run leased elsewhere marks the run,
  and those marks go out as one batched UPDATE per batch of results (new optional
  `StateStore.pullRunWakesIn`, implemented by the Lucid and in-memory stores; other stores keep the
  per-run write). A pod that dies while the acknowledgement waits never acknowledged, so the broker
  redelivers the result to a live instance — the recovery guarantee is unchanged.
- The BullMQ transport now gives a step's task job a deterministic id, derived from the step, its
  attempt and its checkpoint's enqueue time (a retried step's new attempt, or a `requeue`d step's new
  checkpoint, gets a new id), and the same id as a two-minute deduplication id. When recovery re-sends
  the steps of a turn that died mid-flight and the original job is still waiting or running (a backlog
  behind the surviving workers), or finished moments ago with its result still on the way, BullMQ adds
  nothing instead of queueing a second copy. The job payload is unchanged; other transports behave as
  before.
- A step result settled while its run's turn is still in flight (`running`) on a pod that then dies
  after parking the run no longer waits out the 5-minute reconcile wake: if the resume has not ended
  within the same bounded wait, the result's acknowledgement first leaves a durable wake request on
  the run (the stamp a refused wake already uses), which survives the park and makes the run due as
  soon as the dead pod's lease lapses.

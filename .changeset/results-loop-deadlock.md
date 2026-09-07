---
'@adonis-agora/durable': patch
---

A consumed remote-step result no longer wedges the serial results loop behind the run it resumes.

The engine's result handler awaited the resumed turn, and that turn can itself await the NEXT remote step in-memory (a `timeoutMs` step parks on its `pending` waiter) — whose result arrives on that SAME serial loop. One result then held its job un-acked while the awaited next result queued behind it: a self-deadlock broken only when the step's liveness timer fired (minutes) or the run failed — observed as handlers executing in ~2s while results piled in `active`, checkpoints stayed pending, and holders timed out.

Semantics now: consuming a result settles its checkpoint (awaited, so the ack only lands once the completion is durable) and kicks the run's resume fire-and-forget (tracked for `drain`, rejection-captured). At-least-once resume is preserved via run state, not by holding the job: the run stays `suspended` with its reconcile `wakeAt`, so timer recovery re-drives it if the background resume throws or the process dies mid-turn. One visible contract change: a result popped by a pod that cannot resume the run (rolling-deploy skew) is now acked after settling instead of redelivered — the finished checkpoint survives and the next recovery tick replays past it.

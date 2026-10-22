---
'@adonis-agora/durable': patch
---

A remote step with `timeoutMs` no longer times out on a live worker when its heartbeats are consumed by another engine instance.

On a point-to-point transport (the `queue` transport) every instance competes for the heartbeat queue, so a worker's beat can land on an instance that did not dispatch the step. That instance persisted it on the checkpoint, but only the dispatcher holds the liveness timer — it never heard the beat, fired, and failed or re-dispatched a step that was still running. When the window runs out, the dispatcher now reads the checkpoint's `lastHeartbeatAt` first: a beat from this attempt still inside `timeoutMs` re-arms the timer for the rest of the window, and only a step silent on every instance times out. Beats are persisted at most once per step every 10s, so keep `timeoutMs` on a multi-instance fleet comfortably above that.

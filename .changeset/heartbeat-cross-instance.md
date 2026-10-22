---
'@adonis-agora/durable': patch
---

A remote step with `timeoutMs` no longer times out on a live worker when its heartbeats are consumed by another engine instance.

On a point-to-point transport (the `queue` transport) every instance competes for the heartbeat queue, so a worker's beat can land on an instance that did not dispatch the step. That instance persisted it on the checkpoint, but only the dispatcher holds the liveness timer — it never heard the beat, fired, and failed or re-dispatched a step that was still running. When the window runs out, the dispatcher now reads the checkpoint's `lastHeartbeatAt` first: a beat from this attempt still inside `timeoutMs` re-arms the timer for the rest of the window, and only a step silent on every instance times out. Because another instance persists a step's beats at most once every 10s, the beat on the checkpoint can trail the newest one by that much: once the dispatcher sees a persisted beat it did not hear itself, it allows up to 10s of extra silence, so a dead worker is detected within `timeoutMs` + 10s on a multi-instance fleet and within `timeoutMs` on a single instance, as before. The throttle is configurable as the `heartbeatPersistThrottleMs` engine option.

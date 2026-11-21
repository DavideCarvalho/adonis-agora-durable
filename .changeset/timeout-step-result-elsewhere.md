---
'@adonis-agora/durable': patch
---

A dispatched `ctx.step` with `timeoutMs` no longer waits the whole `timeoutMs` when another engine instance consumes its result (#575). The awaiting instance now ends its wait from the settled checkpoint: at once on the other instance's `step.completed` broadcast (control plane), or at the next checkpoint read (new engine option `remoteResultPollMs`, default 1000 ms, `0` off). The dispatch also asks for its result back on the awaiting instance when the transport routes replies, and a failure settled by another instance now fails the step instead of re-dispatching it.

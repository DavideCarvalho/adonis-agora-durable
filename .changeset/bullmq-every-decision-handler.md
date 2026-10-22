---
'@adonis-agora/durable': patch
---

On the `bullmq` transport, a second (or later) remote workflow no longer hangs. The engine builds one remote-workflow executor per remote workflow, and each subscribes to decisions, ignoring the turns it isn't waiting for. `onDecision` kept only the first subscriber, so decisions for every other remote workflow went to an executor that dropped them, and those runs never advanced. Every subscriber now receives every decision.

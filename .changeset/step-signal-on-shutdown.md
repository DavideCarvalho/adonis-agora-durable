---
"@adonis-agora/durable": minor
---

`log.signal`: an `AbortSignal` on the step logger (also `currentStep()?.signal`) that aborts when the worker starts shutting down, so a long step can stop between units of work instead of being cut off mid-item. Every transport aborts it when `close()` starts; the engine aborts it for `ctx.localStep` bodies on `beginDrain()`/`drain()`.

The bullmq transport now hands a step still running at the end of `closeTimeoutMs` back to the broker (`moveToDelayed(now)` under its lock, no attempt counted), as the queue and db transports already did. Before, the job stayed active under the dead process's lock until BullMQ's stalled check found it, and a job that stalled past `maxStalledCount` failed for good with "job stalled more than allowable limit".

`StepLogger` gains a required `signal` member: a hand-written `StepLogger` (a test double) needs `signal: new AbortController().signal`.

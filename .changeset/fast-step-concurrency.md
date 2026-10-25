---
"@adonis-agora/durable": patch
---

The adaptive step concurrency no longer collapses to one on fast steps.

The controller read latency jitter as queuing: its baseline is the fastest completion of the
window, and for 1–5 ms steps p50 sits several times above it with nothing queued, so it shrank to
one or two at a time. p50 may now reach twice the baseline plus 5 ms before it counts as queuing.
Growth doubles the limit until the first back-off, then adds √limit a tick (it added one every 2 s).
Step durations are timed with `performance.now()` instead of whole milliseconds. Same decisions as
the Aviary controller.

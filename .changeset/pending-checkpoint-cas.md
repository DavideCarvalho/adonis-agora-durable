---
'@adonis-agora/durable': minor
---

A step result is no longer overwritten back to `pending`. A turn that stamps a pending step's redispatch deadline (or re-dispatches it) wrote the row it had read a moment earlier. If the worker's result landed in between, the step went back to `pending` with no result, the run parked until the deadline, and the step ran a second time.

- `StateStore.saveCheckpointIfPending` (optional, new) writes only while the stored row is still `pending` and reports whether it wrote. The engine uses it for the redispatch stamp, the redispatch itself, and for settling a step from its result. A result that loses the race is treated like a redelivery (the resume is re-driven, the step is not settled twice). The Lucid, in-memory and codec stores implement it, and the shared store contract covers it. A store without it falls back to `saveCheckpoint`.
- BullMQ result jobs are retried (5 attempts, exponential backoff) when the engine's handler throws, failed ones are kept for 24h instead of deleted, and a result given up on is logged. Before, one store error at peak load dropped the result silently.

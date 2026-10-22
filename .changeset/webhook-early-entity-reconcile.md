---
'@adonis-agora/durable': minor
---

The dashboard's `POST /webhooks/:token` buffers a callback that lands before the run reaches `wait()` (`202 { buffered: true }`) when the token's run exists, is not terminal and has not consumed that webhook yet; the later `wait()` consumes it. Unknown or terminal runs and duplicates still answer `404` and buffer nothing.

Entities: an operation stored in an entity's buffer whose wake was lost (the process died between storing it and waking the entity) is now applied by the worker loop's entity reconcile, at most once a minute (`engine.reconcileEntityWakes()` runs a pass by hand). Stores gain an optional `listBufferedSignalTokens(prefix, limit)`, implemented by the Lucid and in-memory stores and covered by the conformance kit.

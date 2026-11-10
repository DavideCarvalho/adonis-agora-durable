---
"@adonis-agora/durable": patch
---

The db transport's run queue no longer takes runs after its consumer's `stop()` resolved. A poll that was already in flight when `stop()` was called (waiting on the claim's read) could claim runs dispatched afterwards and hand them to the handler. `stop()` now waits for that poll, and a poll that finds the consumer stopping gives back what it claimed.

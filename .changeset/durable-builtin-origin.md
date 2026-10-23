---
'@adonis-agora/durable': patch
---

The engine's built-in workflows — the entity runner (`__entity`) and the `onEvent` accumulators (`__evt_debounce`, `__evt_batch`) — are now registered with `origin: '@adonis-agora/durable'`, so their runs land under the library in the console's ORIGIN facet instead of looking like the app's own. Target runs keep their own registration's origin.

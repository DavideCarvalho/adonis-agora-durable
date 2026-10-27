---
"@adonis-agora/durable-dashboard": patch
---

Less polling: the topology query fetches once (as intended), value pickers refresh every 10s instead of 2s, child-run details of a settled child refresh every 30s instead of 2s, the dead-letter handler probe stops once found (10s while missing), and the stalled-workflows banner is memoized.

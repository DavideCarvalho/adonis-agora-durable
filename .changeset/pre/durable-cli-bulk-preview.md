---
"@adonis-agora/durable": patch
---

`durable:runs:bulk --dry-run` lists every run the action would touch (up to 500, paging the listing) instead of the first 200, and its table shows the same liveness columns as `durable:runs`.

---
"@adonis-agora/durable": patch
---

The `ETag` of the dashboard's run detail (`GET /runs/:id`) no longer covers the run's `input`, `output`, `error` or `searchAttributes`, which a host's `redact` hook may hide from the viewer. It now covers only the run's identity and state fields, its checkpoint buckets and the summarize threshold, and still changes whenever the response body does. No configuration change is needed.

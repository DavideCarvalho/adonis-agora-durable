---
'@adonis-agora/durable': patch
---

perf(otel): `attachDurableMetrics` no longer leaks memory. Runs that start on this instance but never report a terminal event here (suspended and resumed elsewhere, cancelled) are no longer tracked forever — the oldest of more than 10,000 pending starts is dropped. Duration samples are kept as an exact value histogram, so memory scales with distinct millisecond values instead of sample count and `snapshot()` no longer sorts every sample; reported counts and percentiles are unchanged.

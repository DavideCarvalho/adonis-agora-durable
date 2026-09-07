---
'@adonis-agora/durable': patch
---

`attachDurableOtel`'s root span now closes (error status, matching `run.failed`) when a run parks `blocked` via `capability.unavailable`/`protocol.incompatible`, instead of leaking — those two events never previously reached `endRoot()`, so a run stuck waiting on a missing capability or an incompatible worker fleet held its root span (and its entry in the bridge's internal `roots` Map) open for the rest of the process's life. Resuming a blocked run doesn't re-emit `run.started`, so no second root span opens for it later.

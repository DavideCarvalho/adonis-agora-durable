---
"@adonis-agora/durable": patch
"@adonis-agora/durable-dashboard": patch
---

The console links an onError handler run (`<runId>.onError`) to the run it handles, and a run waiting on its handler reads "awaiting · failure handler <workflow>". `parentRunIdOf` reads `<parent>.onError` too, so the diagnostics bridge stamps the handler's `parentRunId`.

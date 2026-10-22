---
'@adonis-agora/durable-dashboard': patch
---

The "queued — behind leader" badge now names the run that holds the singleton slot (the `durable:singleton:admitted` tag) instead of the oldest in-flight run, never shows a sleeping holder as queued, and counts `blocked` runs.

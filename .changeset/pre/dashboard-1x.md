---
"@adonis-agora/durable": patch
"@adonis-agora/durable-dashboard": patch
---

Console fixes found by a smoke test of the 1.0 console:

- **Actions work under shield.** Every write the console sends (cancel, retry, update, signal, task, bulk, schedules) carries the `XSRF-TOKEN` cookie back as `x-xsrf-token`, and a write is never redirected silently: a refused request (a redirect, or any non-2xx answer) shows as an error on the page instead of looking like nothing happened.
- **The `window.__DURABLE_BASE__` / `__DURABLE_API__` overrides are gone.** The provider's JSON config block is the only source; without it the console uses `/durable` and `/durable/api`.
- **The run detail of a waiting run** carries what the run waits on (`run.waiting`, as list rows do), so "Send update", "Deliver signal" and the task actions show whatever page the list is on, and the header reads `awaiting` (or `suspended` for a run parked on nothing named) instead of `running`.
- **A `cancelling` run** reads "Cancelling" instead of falling through to "Saga compensated".
- **The status chips' counts (ALL included)** are recounted with every list refresh.
- The dashboard package no longer lists a README it does not ship.

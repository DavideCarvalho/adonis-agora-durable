---
'@adonis-agora/durable': patch
'@adonis-agora/durable-dashboard': patch
---

Fix "Cancel + Undo" in the dashboard silently performing a plain cancel.

The console sends `POST /api/runs/:id/cancel?compensate=true` on the query string with no request body, but the handler read `compensate` from the JSON body only. The flag was therefore dropped on every cancel issued from the console: the request answered `200`, the UI reported success, and **the saga compensations never ran**. An operator who clicked a button labelled "Cancel and run saga compensations (undo completed steps in reverse)" was told it worked while completed steps were left in place — a wrong answer delivered silently, which is worse than a failed request.

`cancelRun` and `bulkAction` now read the flag from either channel. An explicit body value still wins, so every existing body-based caller behaves exactly as before and the query string is purely additive.

The coercion is an allowlist rather than a truthiness test — `?compensate=false` and `?compensate=0` mean **no**, where `Boolean(raw)` would have read both as yes and run an undo nobody asked for. Accepted: `true`/`1`/`yes`/`on` (and a bare `?compensate`) for yes, `false`/`0`/`no`/`off` for no, case- and whitespace-insensitive. An unrecognised value is now a `400` instead of falling back to a default the caller did not choose; previously `bulk` read any non-`'true'` value as no.

Also on the client: `durableClient.bulk(...)` accepts `compensate`, so the bulk endpoint's documented `?compensate=true` is reachable from the SPA client at all — it previously had no way to send it.

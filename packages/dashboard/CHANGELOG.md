# @adonis-agora/durable-dashboard

## 0.2.1

### Patch Changes

- [#64](https://github.com/DavideCarvalho/adonis-agora-durable/pull/64) [`81bc949`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/81bc949c007dd691aec1a361615e629ec6925841) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix "Cancel + Undo" in the dashboard silently performing a plain cancel.

  The console sends `POST /api/runs/:id/cancel?compensate=true` on the query string with no request body, but the handler read `compensate` from the JSON body only. The flag was therefore dropped on every cancel issued from the console: the request answered `200`, the UI reported success, and **the saga compensations never ran**. An operator who clicked a button labelled "Cancel and run saga compensations (undo completed steps in reverse)" was told it worked while completed steps were left in place — a wrong answer delivered silently, which is worse than a failed request.

  `cancelRun` and `bulkAction` now read the flag from either channel. An explicit body value still wins, so every existing body-based caller behaves exactly as before and the query string is purely additive.

  The coercion is an allowlist rather than a truthiness test — `?compensate=false` and `?compensate=0` mean **no**, where `Boolean(raw)` would have read both as yes and run an undo nobody asked for. Accepted: `true`/`1`/`yes`/`on` (and a bare `?compensate`) for yes, `false`/`0`/`no`/`off` for no, case- and whitespace-insensitive. An unrecognised value is now a `400` instead of falling back to a default the caller did not choose; previously `bulk` read any non-`'true'` value as no.

  Also on the client: `durableClient.bulk(...)` accepts `compensate`, so the bulk endpoint's documented `?compensate=true` is reachable from the SPA client at all — it previously had no way to send it.

- [#63](https://github.com/DavideCarvalho/adonis-agora-durable/pull/63) [`62a44a4`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/62a44a44b99c58d60fdb6d24767478e0c3cf19e5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `engines.node` as a supported RANGE again, and stop Renovate from re-pinning it.

  All three packages shipped an exact runtime string (`"node": "v22.23.2"` / `"node": "v26.7.0"`) instead of a range. `engines.node` states which runtimes a package supports, so an exact value warns on every consumer install on any other Node and fails hard under `engine-strict`. The values were rewritten by Renovate's global `rangeStrategy: "pin"`, so `renovate.json` now disables updates for the `engines` dep type — otherwise the fix is undone on the next cycle.

## 0.2.0

### Minor Changes

- [`1aace98`](https://github.com/DavideCarvalho/adonis-durable/commit/1aace980b3294c52090e7affe0233917cf0aa118) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New React SPA dashboard, with the API surface it needs

  The dashboard is now a proper `@adonis-agora/durable-dashboard` React + Vite + Tailwind SPA (run list
  with virtualization/infinite-scroll pagination, step timeline, workflow topology graph via
  `@xyflow/react`, fix-and-replay, bulk retry/cancel, breakpoint continue, live worker heartbeats), served
  by `@adonis-agora/durable`'s existing `dashboard_provider`. The original hand-rolled
  `assets/dashboard.html` stays mounted at `<path>/legacy` for backward compatibility — nothing already
  depending on it breaks.

  New backend endpoints back the SPA, mirroring `@dudousxd/nestjs-durable-dashboard`'s
  `DurableApiController`:

  - `GET  /api/workers` — full per-group worker health (every live worker's heartbeat, not just a count)
  - `GET  /api/topology` — this deployment's durable role, for the header badge
  - `POST /api/runs/:id/retry-with-input` — fix-and-replay: a fresh linked run with corrected input
  - `POST /api/runs/:id/continue` — resume a run paused at a `ctx.breakpoint()`
  - `POST /api/bulk/:action` (`retry`|`cancel`) — apply an action to every run matching the list filter
  - `GET  /api/runs/:id/stream` — SSE live-tail of one run's lifecycle events
  - `GET  /api/runs` now also filters by `namespace` and repeatable `attr=key:op:value` search-attribute
    predicates

  `dashboardAuth` gains a second, additive auth mode: alongside the existing `login` hook (Mode B —
  built-in login page), a host app can now configure a `session` hook (Mode A) that validates the host's
  OWN auth off the raw request, for an "open the console from your app" button. Either or both may be
  configured; only one is required. `DashboardAuthOptions.login` is now optional (was previously
  required) to make room for `session`-only setups — existing configs with `login` keep working
  unchanged.

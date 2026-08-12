# @adonis-agora/durable-dashboard

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

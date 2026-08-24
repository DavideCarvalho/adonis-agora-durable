---
name: durable-observability
description: >-
  Operate and observe @adonis-agora/durable runs: the embedded dashboard
  (config/durable_dashboard.ts, enabled/path/authorize, dashboardAuth session
  layer with session/login hooks, JSON API for listRuns/retry/retry-with-input/
  cancel/redispatch/bulk, SSE live tail via EventSource), engine.subscribe
  lifecycle events (run.started/completed/failed/suspended, step.*,
  capability.unavailable), engine.use local-step interceptors, collectMetrics
  Prometheus counters, OpenTelemetry tracing (attachDurableOtel,
  otelTraceparent cross-process propagation), and the Telescope Workflows view
  (durableTelescopeExtension). Use when mounting/securing the console,
  scripting run actions, or wiring logs/metrics/traces.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable-dashboard"
  library_version: "0.2.1"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/observability/dashboard.mdx'
  - 'DavideCarvalho/adonis-durable:docs/observability/dashboard-auth.mdx'
  - 'DavideCarvalho/adonis-durable:docs/observability/events-and-interceptors.mdx'
  - 'DavideCarvalho/adonis-durable:docs/observability/otel.mdx'
  - 'DavideCarvalho/adonis-durable:docs/observability/telescope.mdx'
---

# Observing & operating runs

The dashboard mounts an operations console into your AdonisJS app: a React SPA
plus the JSON API it runs on, reading straight from the state store. The SPA is
bundled from `@adonis-agora/durable-dashboard`; its provider and config ship in
the main package.

## Setup

```bash
node ace configure @adonis-agora/durable
# registers @adonis-agora/durable/dashboard_provider + publishes config/durable_dashboard.ts
```

```ts title="config/durable_dashboard.ts"
import { defineConfig } from '@adonis-agora/durable/dashboard'

export default defineConfig({
  // enabled: true,          // default true; false registers no routes at all
  path: '/durable',
  authorize: async (ctx) => {
    await ctx.auth.check()
    return ctx.auth.user?.isAdmin === true // denied requests get 403
  },
})
```

The default `authorize` is open outside production and requires a bearer token
equal to `DURABLE_DASHBOARD_TOKEN` in production (**fails closed if unset**).
The console mutates runs — always front it with a real guard in production.

## Core patterns

### Pattern 1 — operator sign-in with `dashboardAuth`

Opt-in session layer, additive to `authorize` (both must pass). `secret` plus at
least one of `session` / `login`; a mis-wired gate throws at boot:

```ts title="config/durable_dashboard.ts"
import { defineConfig } from '@adonis-agora/durable/dashboard'
import env from '#start/env'
import User from '#models/user'

export default defineConfig({
  path: '/durable',
  dashboardAuth: {
    secret: env.get('DURABLE_DASHBOARD_SECRET'), // HMAC-SHA256 key, 32+ bytes
    ttl: '8h',
    login: async (username, password) => {
      const user = await User.verifyCredentials(username, password).catch(() => null)
      if (!user || !user.isAdmin) return null // null denies
      return { id: String(user.id), name: user.fullName, roles: ['admin'] }
    },
    // or Mode A — mint a session from your app's own cookie via
    // POST <path>/session with credentials: 'include' and redirect: 'manual'.
  },
})
```

Adds `GET/POST <path>/login`, `POST <path>/session`, `GET <path>/logout`. Pages
redirect 302 to login without a valid cookie; API requests get
`401 { error, auth: { modes } }`. Source: `docs/observability/dashboard-auth.mdx`.

### Pattern 2 — fix-and-replay and bulk actions

A run that failed on bad input cannot be retried into success — retry replays
the same input. Fix-and-replay starts a NEW run (`<originalRunId>~retry~<uuid>`,
clean history, original left intact as the record):

```ts
const res = await fetch(`/durable/api/runs/${runId}/retry-with-input`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ input: { orderId: 'ord_42', amount: 1999 } }),
})
const { result } = await res.json()
result.runId // 'run-abc~retry~1f4c9e02'
```

Apply an action to everything a filter matches — same filters as `GET /api/runs`
(`status`, `workflow`, `tag`, `namespace`, repeatable `attr=key:op:value`):

```bash
curl -X POST '/durable/api/bulk/retry?status=failed&workflow=charge-order&namespace=eu-west'
curl -X POST '/durable/api/bulk/cancel?status=suspended&tag=stuck&compensate=true'
```

Bulk acts on at most **500 runs per call**, no paging — compare `matched` to 500
and narrow + repeat. A compensating cancel answers with the PRE-cancel status;
watch the SSE stream until it reaches `cancelled`.
Source: `docs/observability/dashboard.mdx`.

### Pattern 3 — lifecycle events → logs, metrics, traces

Everything observable is one event stream; subscribe directly or use the
shipped bridges:

```ts title="start/durable.ts"
import router from '@adonisjs/core/services/router'
import engine from '@adonis-agora/durable/services/main'
import { attachDurableOtel } from '@adonis-agora/durable/otel'
import { collectMetrics } from '@adonis-agora/durable'

engine.subscribe((event) => {
  if (event.type !== 'run.failed') return
  logger.error({ runId: event.runId, workflow: event.workflow }, 'durable run failed')
})

const metrics = collectMetrics(engine)
router.get('/metrics/durable', ({ response }) => {
  response.header('content-type', 'text/plain; version=0.0.4')
  return metrics.prometheus()
})

const detach = attachDurableOtel(engine) // one root span per run, one per step
```

Event types: `run.started|completed|failed|suspended`, `step.started|
completed|failed` (each retry emits its own `step.failed`), plus
`capability.unavailable` / `protocol.incompatible` carrying full diagnostics.
For distributed tracing across workers, stamp tasks with a provider:

```ts title="config/durable.ts"
import { defineConfig } from '@adonis-agora/durable'
import { otelTraceparent } from '@adonis-agora/durable/otel'

export default defineConfig({
  traceparent: () => otelTraceparent(), // W3C context continues on the worker
})
```

Live-tail one run over SSE:
`new EventSource('/durable/api/runs/${runId}/stream')`.
Source: `docs/observability/events-and-interceptors.mdx`,
`docs/observability/otel.mdx`, `docs/observability/dashboard.mdx`.

### Pattern 4 — golden signals in Telescope

Register the extension once and workflows appear next to requests/queries/jobs:

```ts title="config/telescope.ts"
import { durableTelescopeExtension } from '@adonis-agora/durable/telescope'

export default defineConfig({
  extensions: [durableTelescopeExtension({ runHref: '/durable/runs/{runId}' })],
})
```

Rollups (success rate, throughput, duration percentiles, top failures) come from
captured entries bounded by Telescope's prune window; current-state gauges
(dead/suspended/running/pending NOW) read live from the store via `listRuns`.
Per-run actions stay in the durable dashboard. Source:
`docs/observability/telescope.mdx`.

## Common mistakes

### HIGH trusting an "empty" dashboard config in production

Wrong:

```ts
export default defineConfig({}) // prod, DURABLE_DASHBOARD_TOKEN unset
```

Correct:

```ts
export default defineConfig({
  authorize: async (ctx) => {
    await ctx.auth.check()
    return ctx.auth.user?.isAdmin === true
  },
})
```

Mechanism: the default authorize fails CLOSED in production when the token env
var is unset, so every console route 403s and the console looks broken rather
than leaking — either set the token deliberately or override authorize.
Source: `docs/observability/dashboard.mdx` ("Authorization").

### HIGH making interceptor outputs depend on time, randomness or external state

Wrong:

```ts
engine.use(async (invocation, next) => next().then((r) => ({ ...r, at: Date.now() })))
```

Correct:

```ts
engine.use(async (invocation, next) => {
  const result = await next()
  logger.info({ workflow: invocation.workflow, step: invocation.stepName })
  return result
})
```

Mechanism: interceptors wrap the REAL execution of local steps inside the
deterministic execution path — a returned value that differs between runs makes
replay disagree with the recorded checkpoint. Read, time, log, classify; don't
mutate results nondeterministically. Source:
`docs/observability/events-and-interceptors.mdx` (warning callout).

### MEDIUM expecting interceptors to fire on replay or dispatched steps

Wrong:

```ts
engine.use(enforceInvariant) // "runs on every turn" — it does not
```

Correct: enforce invariants inside the workflow body or step handlers; register
interceptors on the worker's engine to observe dispatched steps there.

Mechanism: a replayed step returns its recorded output without executing (so
timings here are real-execution timings), and dispatched steps execute on
workers in another process — there is no local body to wrap. Source:
`docs/observability/events-and-interceptors.mdx`.

### MEDIUM treating a compensating cancel's response as the final state

Wrong:

```ts
const { run } = await cancelRun(runId, { compensate: true })
if (run.status !== 'cancelled') throw new Error('cancel failed') // premature
```

Correct:

```ts
await cancelRun(runId, { compensate: true })
// poll getRun / subscribe to the stream until status === 'cancelled'
```

Mechanism: cancel-with-compensate answers immediately with the pre-cancel status
while the saga undo replays in the background; only a plain cancel is terminal in
the response itself. Source: `docs/observability/dashboard.mdx` (info callout).

### MEDIUM scraping one pod's collectMetrics counters as fleet totals

Wrong:

```yaml
# one Prometheus target pointed at a single web pod
```

Correct:

```yaml
# scrape /metrics/durable on EVERY engine-bearing pod; aggregate in PromQL
```

Mechanism: counters are per process and reset on restart, so one target both
undercounts the fleet and zeroes on every deploy of that pod. Source:
`docs/observability/events-and-interceptors.mdx` ("Counters are per process").

See also: `durable-reliability` — what the events mean operationally; bulk
cancel + compensate semantics.
See also: `durable-cluster` — which verbs proxy over the wire on store-less pods
(`retry-with-input` / `continue` answer 404 there).

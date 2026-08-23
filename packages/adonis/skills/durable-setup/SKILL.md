---
name: durable-setup
description: >-
  Install and configure @adonis-agora/durable in an AdonisJS app: node ace add,
  config/durable.ts with defineConfig and driver-by-name transports/stores maps
  (memory, event-emitter, queue, db, bullmq; lucid store), the WorkflowEngine
  container singleton from @adonis-agora/durable/services/main,
  Workflow.dispatch vs .start, where runs execute (in-process dispatcher,
  NOOP_RUN_DISPATCHER, durable:work), consumers, leaseMs. Use when setting up
  durable workflows for the first time, moving from dev defaults to production
  infrastructure, or diagnosing "runs vanish on restart" / "workflows compete
  with HTTP traffic".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/getting-started.mdx'
  - 'DavideCarvalho/adonis-durable:docs/concepts/durability.mdx'
  - 'DavideCarvalho/adonis-durable:docs/transports/index.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/failure-modes.mdx'
  - 'DavideCarvalho/adonis-durable:README.md'
---

# Setting up @adonis-agora/durable

`@adonis-agora/durable` is a durable workflow engine for AdonisJS: workflows are
plain async code whose steps are checkpointed, so a crash or deploy resumes from
the last checkpoint instead of starting over. The published `config/durable.ts`
defaults to zero infrastructure (in-process transport + in-memory store) — that
default is for development only.

## Setup

Install via ace (registers `@adonis-agora/durable/durable_provider` in
`adonisrc.ts` and publishes `config/durable.ts`):

```bash
node ace add @adonis-agora/durable
```

The provider binds a singleton `WorkflowEngine` built from the config. Import it
anywhere with `import engine from '@adonis-agora/durable/services/main'`.

```ts title="config/durable.ts"
import { defineConfig, stores, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'event-emitter',
  transports: {
    memory: transports.memory(),
    'event-emitter': transports.eventEmitter(),
    // queue: transports.queue({ connection: 'redis' }), // names a config/queue.ts adapter
    // db: transports.db(),
  },
  store: 'lucid',
  stores: { lucid: stores.lucid() },
})
```

Define a workflow class under `app/workflows/` (auto-registered at boot):

```ts title="app/workflows/checkout_workflow.ts"
import { BaseWorkflow } from '@adonis-agora/durable'
import type { WorkflowCtx } from '@adonis-agora/durable'

export default class CheckoutWorkflow extends BaseWorkflow {
  static workflow = { name: 'checkout', version: '1' }

  async run(ctx: WorkflowCtx, order: { id: number; total: number }) {
    await ctx.localStep('reserveStock', async () => ({ reserved: true }))
    const approval = await ctx.waitForSignal<{ approved: boolean }>(`approve:${order.id}`)
    if (!approval.approved) return { status: 'rejected' }
    return { status: 'shipped' }
  }
}
```

Start a run from a controller — `dispatch` enqueues and returns immediately:

```ts title="app/controllers/checkout_controller.ts"
import type { HttpContext } from '@adonisjs/core/http'
import CheckoutWorkflow from '#workflows/checkout_workflow'
import Order from '#models/order'

export default class CheckoutController {
  async store({ request, response }: HttpContext) {
    const total = request.input('total') as number
    const order = await Order.create({ total })
    const { runId } = await CheckoutWorkflow.dispatch(
      { id: order.id, total: order.total },
      { runId: `checkout:${order.id}` }, // stable runId = idempotency key
    )
    return response.accepted({ runId })
  }
}
```

Source: `docs/getting-started.mdx`, `docs/index.mdx`.

## Core patterns

### Pattern 1 — production single-process config

For a deployed app that stays one process, pair the Lucid store with the
`eventEmitter` transport. Checkpoints survive restarts in Postgres while steps
never leave the process:

```ts title="config/durable.ts"
import { defineConfig, stores, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'event-emitter',
  transports: { 'event-emitter': transports.eventEmitter() },
  store: 'lucid',
  stores: { lucid: stores.lucid() },
  leaseMs: 30_000,
})
```

Run `node ace durable:work` alongside (or rely on the embedded worker) so
recovery, timers and schedules are driven even if you later split processes.
Source: `docs/transports/index.mdx`.

### Pattern 2 — split web from workers

`engine.start()` never blocks the caller, but by default the body executes on a
microtask **on the calling instance**. On an API/dashboard pod that means heavy
runs compete with HTTP traffic and the DB pool. Pass `NOOP_RUN_DISPATCHER` so
the API pod only creates runs, and let `durable:work` execute them:

```ts title="config/durable.ts (API/dashboard pod)"
import { NOOP_RUN_DISPATCHER, defineConfig, stores, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'queue',
  transports: { queue: transports.queue({ connection: 'redis' }) },
  store: 'lucid',
  stores: { lucid: stores.lucid() },
  runDispatcher: NOOP_RUN_DISPATCHER, // create runs; never execute bodies here
})
```

```bash title="a separate worker process"
node ace durable:work --interval=500 --drainTimeout=15000
```

Each `durable:work` tick runs `engine.runPending()` → `recoverIncomplete()` →
`resumeDueTimers()` → `sweepTimeouts()` → fires due schedules, then drains on
`SIGINT`/`SIGTERM`. Source: `docs/concepts/durability.mdx`,
`docs/reliability/failure-modes.mdx`, `docs/cli.mdx`.

### Pattern 3 — dispatch vs start vs waitForRun

One rule: `.dispatch(input)` = fire-and-forget (`{ runId }`); `.start(input)` =
block until the run settles (terminal state or suspended) and get the result;
`engine.waitForRun(runId)` resolves a previously started run.

```ts
const { runId } = await OrderWorkflow.dispatch(order) // hot path — respond now
const result = await OrderWorkflow.start(order) // scripts / short runs only
await engine.start('order', order, runId)
const settled = await engine.waitForRun(runId) // resolves on settle
```

`.start` blocks the calling context — avoid it on a hot HTTP path for
long-running workflows. Source: `docs/getting-started.mdx`,
`docs/authoring/app-workflows.mdx`.

### Pattern 4 — optional peers install only when selected

Every driver lazily imports its optional peer (`@adonisjs/lucid`,
`@adonisjs/queue`, `@adonisjs/redis`, `bullmq`, `@opentelemetry/api`) only when
that driver is named in config. Add the peer to the app that uses it:

```bash
npm i @adonisjs/lucid        # lucid store / db transport
node ace configure @adonisjs/lucid && node ace migration:run
npm i bullmq                 # bullmq transport (cross-ecosystem fleets)
npm i cron-parser            # cron-based schedules
```

`cron-parser` is needed wherever schedules with a `cron` field fire (the worker
host). Source: `docs/stores/lucid.mdx`, `docs/authoring/scheduling.mdx`,
`packages/adonis/package.json` (peerDependencies).

## Common mistakes

### CRITICAL shipping the in-memory default store

Wrong:

```ts
// Works locally, then every run and checkpoint vanishes on restart/deploy.
export default defineConfig({
  transport: 'memory',
  transports: { memory: transports.memory() },
})
```

Correct:

```ts
export default defineConfig({
  transport: 'event-emitter',
  transports: { 'event-emitter': transports.eventEmitter() },
  store: 'lucid',
  stores: { lucid: stores.lucid() },
})
```

Mechanism: with no `store` key the engine uses the in-memory store — no error,
no warning, just state loss across restarts. The in-memory store is documented
as "for tests and local dev. Not durable."
Source: `docs/stores/index.mdx`, `docs/getting-started.mdx`.

### HIGH using `transports.memory()` as the single-process production driver

Wrong:

```ts
transport: 'memory' // "it's all one process anyway"
```

Correct:

```ts
transport: 'event-emitter',
transports: { 'event-emitter': transports.eventEmitter() },
```

Mechanism: `memory` executes the handler **inline inside the dispatch call**;
`eventEmitter` delivers on a later tick like a real broker, so code correct on
`eventEmitter` is correct on a broker too. The docs warn explicitly:
"memory is for tests; eventEmitter is the single-process production driver".
Source: `docs/transports/index.mdx`.

### HIGH letting workflows share the API pod's event loop

Wrong:

```ts
// API/dashboard pod, default config — a burst of CPU-heavy runs starves requests.
export default defineConfig({ transport: 'queue', transports: { /* … */ } })
```

Correct:

```ts
import { NOOP_RUN_DISPATCHER, defineConfig } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'queue',
  transports: { /* … */ },
  runDispatcher: NOOP_RUN_DISPATCHER,
})
```

plus `node ace durable:work` as its own process. Mechanism: the default
in-process dispatcher executes bodies on the same instance, event loop and DB
pool as the HTTP handler that called `start()`; a saturated pool starves both.
Source: `docs/reliability/failure-modes.mdx` ("The in-process default
surprise"), `docs/concepts/durability.mdx`.

### MEDIUM expecting a `node ace` script to await a remote step result

Wrong:

```ts
// inside `node ace run-report` — hangs forever on a queue/db/bullmq transport
const { runId } = await OrderWorkflow.dispatch(input)
const result = await engine.waitForRun(runId)
```

Correct:

```ts
export default defineConfig({
  // …
  consumers: 'always', // opt this process into broker consumption
})
```

—or don't round-trip inline: start the run, exit, let the worker fleet finish
it. Mechanism: console/repl processes deliberately do not start broker consumer
loops (they would claim jobs and die holding them), so nothing receives results
in that process unless `consumers: 'always'`.
Source: `docs/transports/queue.mdx` ("consumers").

See also: `durable-transports-stores` — picking drivers, namespaces, migrations.
See also: `durable-workflows` — authoring the workflow classes you just wired.

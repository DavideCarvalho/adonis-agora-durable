---
name: durable-workflows
description: >-
  Author durable workflows and steps with @adonis-agora/durable: BaseWorkflow
  classes under app/workflows (static workflow, constructor @inject DI,
  dispatch/start statics, make:workflow), step handlers via @Step decorators,
  defineStep, string names or transport.handle, ctx.localStep vs always-
  dispatched ctx.step, durable sleeps (ctx.sleep/sleepUntil), signals
  (waitForSignal/signal/signalWithStart), named events (waitForEvent/
  publishEvent/eventBatch/onEvent/idempotent opts.id), webhooks (ctx.webhook),
  external tasks (ctx.task/completeTask/failTask), transactional steps
  (ctx.transaction), breakpoints, child workflows (child/startChild/all/
  continueAsNew/GatherError), singleton workflows, entities (registerEntity/
  callEntity), scheduling (ScheduledWorkflow/static schedule/@Scheduled),
  tags and search attributes. Use when writing or composing workflow logic.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/authoring/app-workflows.mdx'
  - 'DavideCarvalho/adonis-durable:docs/concepts/workflows-and-steps.mdx'
  - 'DavideCarvalho/adonis-durable:docs/concepts/sleep-and-signals.mdx'
  - 'DavideCarvalho/adonis-durable:docs/authoring/child-workflows.mdx'
  - 'DavideCarvalho/adonis-durable:docs/authoring/webhooks.mdx'
  - 'DavideCarvalho/adonis-durable:docs/authoring/entities.mdx'
  - 'DavideCarvalho/adonis-durable:docs/authoring/scheduling.mdx'
---

# Authoring workflows & steps

A workflow is a class under `app/workflows/` extending `BaseWorkflow` with a
`static workflow = { name, version }`. The provider scans the directory at boot
and registers every exported class — you never call `engine.register` by hand
(it remains the low-level escape hatch). The convention mirrors `@adonisjs/queue`
jobs under `app/jobs`; scaffold with `node ace make:workflow order`.

## Setup

```ts title="app/workflows/checkout_workflow.ts"
import { inject } from '@adonisjs/core'
import { BaseWorkflow } from '@adonis-agora/durable'
import type { WorkflowCtx } from '@adonis-agora/durable'

export default class CheckoutWorkflow extends BaseWorkflow {
  static workflow = { name: 'checkout', version: '1' }

  async run(ctx: WorkflowCtx, order: { id: number; total: number }) {
    await ctx.localStep('reserveStock', async () => ({ reserved: true }))
    const charge = await ctx.step('payments:charge-card', {
      orderId: order.id,
      amountCents: order.total,
    })
    const approval = await ctx.waitForSignal<{ approved: boolean }>(`approve:${order.id}`)
    if (!approval.approved) return { status: 'rejected', chargeId: charge.chargeId }
    await ctx.localStep('ship', async () => ({ shipped: true }))
    return { status: 'shipped', chargeId: charge.chargeId }
  }
}
```

Run it from anywhere: `CheckoutWorkflow.dispatch(input, { runId })` enqueues;
`CheckoutWorkflow.start(input)` awaits the settled result. Both statics are
context-aware — inside a running body they become a linked child /
fire-and-forget child instead of a top-level run.

## Core patterns

### Pattern 1 — typed steps with `@Step`, `defineStep`, and DI

Steps are discovered from `app/steps` and served by name automatically. A
`@Step` method ref passed to `ctx.step` gives full input/output typing:

```ts title="app/steps/payment_steps.ts"
import { Step } from '@adonis-agora/durable'
import { z } from 'zod'

export default class PaymentSteps {
  @Step({
    name: 'payments:charge-card',
    input: z.object({ orderId: z.number().int(), amountCents: z.number().int() }),
    output: z.object({ chargeId: z.string() }),
    retries: 3,
  })
  async chargeCard(input: { orderId: number; amountCents: number }) {
    return { chargeId: await stripe.charge(input) }
  }
}
```

```ts title="app/workflows/order_workflow.ts"
import { inject } from '@adonisjs/core'
import { BaseWorkflow } from '@adonis-agora/durable'
import type { WorkflowCtx } from '@adonis-agora/durable'
import PaymentSteps from '#steps/payment_steps'

@inject()
export default class OrderWorkflow extends BaseWorkflow {
  static workflow = { name: 'order', version: '1' }

  constructor(private payments: PaymentSteps) {
    super()
  }

  async run(ctx: WorkflowCtx, order: Order) {
    // Typed both ways — renaming chargeCard is a compile error here:
    const charge = await ctx.step(this.payments.chargeCard, {
      orderId: order.id,
      amountCents: order.total,
    })
    return { chargeId: charge.chargeId }
  }
}
```

The instance is built once at registration and reused for every run — treat the
constructor as wiring; keep per-run state in input and step outputs, never on
`this`. Injected services are for **composing**, not doing work: reach them
through step refs so the work is checkpointed.

### Pattern 2 — pausing durably: sleeps, signals, events

All three suspend the run with zero compute and survive restarts.

```ts
// Time-based wait — duration string or ms:
await ctx.sleep('7 days')
await ctx.sleepUntil(new Date('2026-12-31T00:00:00Z'))

// Human-in-the-loop / webhook callback — point-to-point by token:
const decision = await ctx.waitForSignal<{ approved: boolean }>(`approve:${order.id}`, {
  timeoutMs: 24 * 60 * 60 * 1000, // throws SignalTimeoutError when the deadline passes
})

// Named pub/sub — one publish fans out to every matching waiter:
const settled = await ctx.waitForEvent<{ orderId: string }>('payment.settled', {
  match: { orderId: order.id },
})
```

Deliver from controllers: `engine.signal(token, payload)` resumes one waiter;
signals sent before the waiter registers are buffered, not lost;
`engine.signalWithStart(workflow, input, runId, { token, payload })` starts the
run if missing and delivers in one race-free call. Publish events with
`engine.publishEvent(name, payload, { id: event.id })` — the upstream event id
makes redelivery a no-op for `onEvent` starts. Register a workflow to start on
events with `{ onEvent: ['payment.settled'] }`; coalesce chatty sources with
`eventBatch: { mode: 'debounce', windowMs: 5_000 }` (last payload wins) or
`{ mode: 'batch', maxSize: 50, windowMs: 60_000 }` (receives `{ events: [...] }`).

```ts title="app/controllers/approvals_controller.ts"
import { inject } from '@adonisjs/core'
import { WorkflowEngine } from '@adonis-agora/durable'

@inject()
export default class ApprovalsController {
  constructor(private engine: WorkflowEngine) {}

  async approve({ params, request, response }: HttpContext) {
    await this.engine.signal(`approve:${params.id}`, request.body())
    return response.noContent()
  }
}
```

### Pattern 3 — children, fan-out, and singletons

```ts
const shipment = await ctx.child(ShippingWorkflow, { orderId: order.id }) // parent suspends
await ctx.startChild('reindex-search', { postId: post.id }) // fire-and-forget
const results = await ctx.all(ProcessItemWorkflow, batch.items) // outputs in input order
if (input.n < 3) await ctx.continueAsNew({ n: input.n + 1 }) // clean history per generation
```

`ctx.all` default mode is `waitAll`: every sibling finishes, then the call throws
a `GatherError` carrying `.failures`; `{ mode: 'failFast' }` cancels remaining
siblings (plain cancel — no saga). Child ids derive from the call position and
are replay-stable; never pass a random one.

Serialize runs per subject with a singleton — runs sharing a key queue FIFO and
are race-free across instances:

```ts
export default class SyncShopWorkflow extends BaseWorkflow {
  static workflow = {
    name: 'sync-shop',
    version: '1',
    singleton: { key: (input) => (input as { shopId: string }).shopId, limit: 1, maxQueueDepth: 20 },
  }
  // …
}
```

Overflow beyond `limit + maxQueueDepth` rejects `dispatch` with
`SingletonQueueFullError` before anything is created.

### Pattern 4 — long-lived state, callbacks, cadences

Entities serialize operations per key without DB locks (register from a
preload):

```ts title="start/entities.ts"
import engine from '@adonis-agora/durable/services/main'

engine.registerEntity<{ balanceCents: number }>('account', {
  initialState: () => ({ balanceCents: 0 }),
  handlers: {
    deposit: (state, amountCents: number) => {
      state.balanceCents += amountCents
      return state.balanceCents
    },
    balance: (state) => state.balanceCents,
  },
})
// drive: engine.signalEntity('account', key, 'deposit', 500)
// read:  engine.getEntityState('account', key)
// from a workflow: await ctx.callEntity('account', key, 'deposit', 500)
```

Wait on a foreign system's own callback by id (`engine.completeTask(runId, name,
result)` / `failTask` resume the run):

```ts
const result = await ctx.task<TranscodeResult>(job.id, async () => {
  await sqs.send({ queueUrl, body: JSON.stringify({ jobId: job.id, src: job.src }) })
})
```

Recurring cadences are colocated on the class (or set in `config/durable.ts`
`schedules`, which overrides by `key`); cron needs `cron-parser` installed where
the worker runs, and only the `durable:work` loop fires schedules:

```ts
export default class DailyReportWorkflow extends BaseWorkflow {
  static workflow = { name: 'daily-report', version: '1' }
  static schedule = { cron: '0 2 * * *', timezone: 'America/Sao_Paulo' }
  // or: @Scheduled({ everyMs: 60_000 }) above the class
}
```

Each schedule window starts exactly once across a fleet via an idempotent
time-bucket run id.

Source: `docs/authoring/entities.mdx`, `docs/authoring/external-tasks.mdx`,
`docs/authoring/scheduling.mdx`.

## Common mistakes

### HIGH calling an injected service directly inside `run`

Wrong:

```ts
async run(ctx, input) {
  const receipt = await this.billing.charge(input) // I/O outside a step
  return { receipt }
}
```

Correct:

```ts
async run(ctx, input) {
  const receipt = await ctx.step(this.billing.charge, input)
  return { receipt }
}
```

Mechanism: work done outside `ctx.step`/`ctx.localStep` is never checkpointed,
so it re-executes on every replay and its result is not durable. The docs warn
explicitly that injected services exist "for composing the workflow, not for
doing its work". Source: `docs/authoring/app-workflows.mdx`.

### HIGH swallowing control-flow signals in a hand-rolled try/catch

Wrong:

```ts
try {
  await ctx.step('chargeCard', input)
} catch (error) {
  await ctx.step('refund', input) // also catches suspend/continue-as-new signals!
  throw error
}
```

Correct:

```ts
import { isWorkflowControlFlowSignal } from '@adonis-agora/durable'

try {
  await ctx.step('chargeCard', input)
} catch (error) {
  if (isWorkflowControlFlowSignal(error)) throw error
  await ctx.step('refund', input)
  throw error
}
```

Mechanism: `ctx.sleep`, `ctx.waitForSignal` and `ctx.continueAsNew` unwind the
turn by throwing; running your failure path on one records extra history a later
replay never produces → `NonDeterminismError` on resume. The predicate checks a
stamped marker, deliberately `false` for cancellations and real failures.
Source: `docs/concepts/workflows-and-steps.mdx` ("Catching errors").

### HIGH passing a random child id inside a workflow

Wrong:

```ts
await ctx.startChild('reindex-search', item, crypto.randomUUID())
```

Correct:

```ts
await ctx.startChild('reindex-search', item) // deterministic positional id
```

Mechanism: inside a body, omitted child ids are derived deterministically from
the call position so replay re-attaches to the same child; a fresh random id on
each replay breaks that dedup and re-fires the child. Source:
`docs/authoring/child-workflows.mdx` ("opts.runId — outside vs inside").

### MEDIUM blocking a hot HTTP path on `.start`

Wrong:

```ts
const result = await CheckoutWorkflow.start(order) // request held open until settle
```

Correct:

```ts
const { runId } = await CheckoutWorkflow.dispatch(order, { runId: `checkout:${order.id}` })
return response.accepted({ runId })
```

Mechanism: `.start` resolves only when the run reaches a terminal state or
`suspends` — hours later for a long workflow. Source: `docs/getting-started.mdx`
(warning callout).

### MEDIUM awaiting a webhook with no timeout

Wrong:

```ts
const result = await hook.wait() // suspends indefinitely if the provider never calls back
```

Correct:

```ts
import { SignalTimeoutError } from '@adonis-agora/durable'

try {
  const result = await hook.wait({ timeoutMs: 30 * 60 * 1000 })
} catch (error) {
  if (!(error instanceof SignalTimeoutError)) throw error
  // reconcile: poll the provider instead of hanging forever
}
```

Mechanism: without `timeoutMs` there is no wake timer — a dropped callback
leaves the run parked invisibly to the timer poller and crash recovery.
Source: `docs/authoring/webhooks.mdx` ("Not waiting forever").

### MEDIUM throwing business rejections out of entity handlers

Wrong:

```ts
withdraw: (state, amountCents) => {
  if (amountCents > state.balanceCents) throw new Error('insufficient funds')
  state.balanceCents -= amountCents
  return state.balanceCents
},
```

Correct:

```ts
withdraw: (state, amountCents) =>
  amountCents > state.balanceCents
    ? { ok: false as const, reason: 'insufficient_funds' as const }
    : ((state.balanceCents -= amountCents), { ok: true as const }),
```

Mechanism: a throwing handler fails the entity's immortal run, stranding every
caller suspended on `ctx.callEntity`; model expected rejections as returned
discriminated results and reserve throws for genuine programmer errors.
Source: `docs/authoring/entities.mdx` (warning callout).

See also: `durable-determinism` — why the body must stay deterministic and how
to change it safely once live.

---
name: durable-reliability
description: >-
  Recover and harden @adonis-agora/durable runs: step retries with fixed/exp
  backoff and jitter, FatalError and worker retryable:false, timeoutMs liveness
  vs the durable suspend path, pickupTimeoutMs, log.heartbeat, saga
  compensation (compensate callbacks/refs, UndoOf, compensationRetries,
  cancel({compensate:true})), flow-control queues (registerQueue, concurrency,
  rateLimit, fairnessKey) with Redis-backed global admission (admission-redis),
  the dead-letter queue (maxRecoveryAttempts, onDead, retryWithInput), the
  stuck-run playbook (stranded signature, redispatchPending,
  remoteRedispatchMs), ace ops commands (durable:work/runs/retry --stale), and
  the testing harness (createTestEngine, tick, failOnce, conformance kits).
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/reliability/retries.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/sagas.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/dead-letter.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/flow-control.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/failure-modes.mdx'
  - 'DavideCarvalho/adonis-durable:docs/cli.mdx'
  - 'DavideCarvalho/adonis-durable:docs/testing.mdx'
---

# Reliability & operations

A run's world is unreliable: APIs time out, workers crash, downstream systems
rate-limit. The engine treats retries, compensation, admission control and
dead-lettering as first-class primitives — and gives operators a symptom → fix
map for the runs that still get stuck.

## Setup

Retries are declared per step; `FatalError` opts a deterministic business
failure out of the retry path:

```ts title="app/steps/charge.ts"
import { defineStep } from '@adonis-agora/durable'

export const chargeCard = defineStep(
  'payments:charge-card',
  async (input: { orderId: number; amountCents: number }) => {
    const res = await stripe.charge(input)
    if (res.declined) {
      // deterministic verdict — don't make the engine retry it
      throw Object.assign(new Error('card declined'), { code: 'declined', retryable: false })
    }
    return { chargeId: res.id }
  },
  { retries: 4, backoff: 'exp', backoffMs: 500, backoffMaxMs: 30_000, jitter: true },
)
```

A dispatched step WITHOUT `timeoutMs` takes the durable path: failure → persist
`wakeAt = now + backoff(attempt)` on the checkpoint → suspend → the timer poller
re-dispatches. Crash-safe, never held in memory.

## Core patterns

### Pattern 1 — sagas: undo completed steps in reverse

Attach a `compensate` to each side-effecting step; when the run fails, undos run
last-completed-first:

```ts
engine.register('checkout', '1', async (ctx, order: Order) => {
  await ctx.localStep('reserve-inventory', () => inventory.reserve(order.items), {
    compensate: () => inventory.release(order.items),
  })

  await ctx.localStep(
    'charge-card',
    () => payments.charge(order.customerId, order.totalCents),
    { compensate: () => payments.refundOnce(order.customerId, order.totalCents) },
  )

  await ctx.localStep('allocate-shipment', () => shipping.allocate(order))
  return { ok: true }
})
```

The saga is reconstructed from history on replay, so it works after a crash.
Dispatched steps compensate with a **step ref** receiving an `UndoOf<...>`
envelope (`{ input, output }`). Engine-level `compensationRetries` (default 1)
bounds transient undo failures; failing compensations are skipped so they can't
mask the original error. Trigger deliberately with
`await engine.cancel(runId, { compensate: true })` or
`engine.cancelWhere(filter, { compensate: true })`. Every undo surfaces as a
visible `compensate:<step>` event. Source: `docs/reliability/sagas.mdx`.

### Pattern 2 — flow-control queues + fleet-wide admission

Cap concurrency/rate durably — a blocked call re-suspends with a persisted
`retryAt`, driven by the timer poller (nothing waits in memory):

```ts title="start/durable.ts"
engine.registerQueue({ name: 'emails', concurrency: 10, rateLimit: { limit: 1000, periodMs: 3_600_000 } })
```

```ts
const sent = await ctx.step(sendEmail, input, { queue: 'emails', priority: 10, fairnessKey: order.tenantId })
```

Accounting is per engine instance by default. For a cap that holds across every
pod, select the Redis admission backend (ships in the main package):

```bash
npm i @adonisjs/redis
```

```ts title="config/durable.ts"
import { admissions, defineConfig } from '@adonis-agora/durable'

export default defineConfig({
  // …
  admission: admissions.redis({ connection: 'main' }),
})
```

Each admit is one atomic Lua script (priority desc → fairness round-robin →
FIFO/LIFO); a crashed pod's slots free within `instanceTtlMs`.
Source: `docs/reliability/flow-control.mdx`.

### Pattern 3 — dead-letter poison pills

Crash-recovery reclaims orphaned runs within ~`leaseMs`; a run that crashes the
process every time would loop forever. Cap it and route the terminal `dead`
status into a handler workflow (idempotent by the `dlq:<runId>` start id):

```ts title="config/durable.ts"
export default defineConfig({
  // …
  maxRecoveryAttempts: 5, // then dead-letter instead of crash-looping
})
```

```ts title="start/durable.ts"
engine.onDead((run) => {
  void engine.start(
    'dlq',
    { deadRunId: run.id, workflow: run.workflow, input: run.input, error: run.error },
    `dlq:${run.id}`,
  )
})
```

A dead run stays inspectable and retriable (`durable:retry <runId>`, dashboard
retry, or `engine.retryWithInput(runId, fixedInput)` for bad data).
Source: `docs/reliability/dead-letter.mdx`.

### Pattern 4 — the stuck-run playbook

A lost remote dispatch does **not** self-heal by default: the run cycles
`suspended → reconcile → suspended` forever with no error. The stranded
signature: status `suspended`, stale `updatedAt`, newest checkpoint
`kind: 'remote' / status: 'pending'`, old `enqueuedAt`. Find it, then heal it:

```bash
node ace durable:runs --stale=1h   # threshold above your longest legitimate step
node ace durable:retry checkout:1234
```

```ts title="app/controllers/ops_controller.ts"
import { inject } from '@adonisjs/core'
import {
  DEFAULT_STALE_MS,
  WorkflowEngine,
  attachLiveness,
  filterStale,
  listRuns,
} from '@adonis-agora/durable'

@inject()
export default class OpsController {
  constructor(private engine: WorkflowEngine) {}

  async strandedRuns({ response }: HttpContext) {
    const runs = await listRuns(this.engine, { statuses: ['running', 'suspended'], limit: 200 })
    const stale = filterStale(await attachLiveness(this.engine, runs), DEFAULT_STALE_MS)
    return response.ok({ stranded: stale.map(({ run }) => run.id) })
  }
}
```

Three nets, in preference order:
1. Per-step `timeoutMs` (+ heartbeat-aware liveness; split queue wait with
   `pickupTimeoutMs`) — but its timer dies with the coordinating process.
2. Engine-level `remoteRedispatchMs` / `remoteRedispatchMax` (default bound 10;
   fails the step with `RemoteStepError` code `'remote_step_lost'` beyond it) —
   must exceed the longest legitimate step; steps must be idempotent.
3. `engine.redispatchPending(runId)` — the operator escape hatch, safe on a
   healthy run (only touches already-pending checkpoints).

Source: `docs/reliability/failure-modes.mdx`, `docs/cli.mdx`.

### Pattern 5 — test workflows without infrastructure

```ts
import { assertRunStatus, createTestEngine, failOnce } from '@adonis-agora/durable/testing'

test('checkout completes', async () => {
  const t = createTestEngine() // in-memory store + transport + controllable clock
  t.engine.register('checkout', '1', async (ctx) => {
    await ctx.localStep('charge', failOnce({ ok: true }), { retries: 3 })
    await ctx.sleep('7 days')
    return { done: true }
  })

  await t.run('checkout', {}, 'run1') // enqueues AND waits for settle
  await t.tick(7 * 24 * 60 * 60 * 1000) // advance the clock past the sleep
  await assertRunStatus(t.store, 'run1', 'completed')
})
```

Custom adapters prove themselves against the shipped contracts:
`runStateStoreContract(name, factory)` and
`runAdmissionBackendContract(name, factory)` live on
`@adonis-agora/durable/testing/conformance` (they generate vitest suites);
`assertTransportConformance(transport)` stays on `/testing` as a plain async
call. Source: `docs/testing.mdx`.

## Common mistakes

### CRITICAL assuming a lost remote dispatch self-heals

Wrong:

```ts
// Deploy and hope: the run stays suspended, its remote step pending forever.
```

Correct:

```ts
export default defineConfig({
  remoteRedispatchMs: 30 * 60_000, // opt in explicitly
  remoteRedispatchMax: 10,
})
// or per-step timeoutMs — or engine.redispatchPending(runId) right now
```

Mechanism: the periodic reconcile replays straight back into the "still pending"
guard and re-suspends rather than re-dispatching, because the engine cannot tell
a dead worker from a slow one. The docs state this is deliberate ("by design").
Source: `docs/reliability/failure-modes.mdx`.

### HIGH tuning detection windows below the slowest real step

Wrong:

```ts
export default defineConfig({ remoteRedispatchMs: 60_000 }) // imports legitimately take ~20min
```

Correct:

```ts
export default defineConfig({ remoteRedispatchMs: 30 * 60_000, remoteRedispatchMax: 10 })
```

Mechanism: once a pending checkpoint ages past the window the SAME `stepId` is
re-dispatched — a slow-but-live worker's step double-executes. Both requirements
are non-negotiable in the docs: window > longest legitimate step, and idempotent
steps. Source: `docs/reliability/failure-modes.mdx`.

### HIGH inferring in-flight runs from `run.started − run.completed`

Wrong:

```ts
const inFlight = counts['run.started'] - counts['run.completed'] // wildly overcounts
```

Correct:

```ts
const inFlight = counts['run.started'] - (counts['run.completed'] + counts['run.failed'])
// or read the store: listRuns({ status: ['running', 'suspended'] })
```

Mechanism: `run.suspended` fires on EVERY park — each sleep, signal wait, child
wait — and suspended runs have not completed; counting starts minus completions
treats every parked run as finished-or-inflight incorrectly either way. The docs
warn: "Never count run.started against run.completed to infer 'runs in flight'".
Source: `docs/observability/events-and-interceptors.mdx`.

### MEDIUM reading an empty `workerHealth()` as a healthy fleet

Wrong:

```ts
const stalled = (await engine.workerHealth()).some((g) => g.stalled) // always false on queue/db
```

Correct:

```ts
const stale = filterStale(
  await attachLiveness(engine, await listRuns(engine, { statuses: ['running', 'suspended'], limit: 200 })),
  DEFAULT_STALE_MS,
)
```

Mechanism: group health is BullMQ-only — on `queue`, `db` or `eventEmitter`,
`workerHealth()` returns `[]`, not an error, so "no stalled groups reported" says
nothing. Use the stranded-signature query instead. Source:
`docs/reliability/failure-modes.mdx`.

### MEDIUM writing non-idempotent saga compensations

Wrong:

```ts
{ compensate: () => payments.refund(order.customerId, order.totalCents) } // refunds again on retry
```

Correct:

```ts
{ compensate: () => payments.refundOnce(order.customerId, order.totalCents) } // keyed, idempotent
```

Mechanism: compensations may run more than once (`compensationRetries`) and are
reconstructed from history across crashes; refund/release must no-op when
already applied or a retry double-refunds. Source: `docs/reliability/sagas.mdx`.

### MEDIUM expecting `failFast` fan-out to clean up siblings

Wrong:

```ts
await ctx.all(ProcessItemWorkflow, items, { mode: 'failFast' }) // assumes undone work
```

Correct:

```ts
// Give ProcessItemWorkflow its own compensations; cancel deliberately with:
await engine.cancel(childRunId, { compensate: true })
```

Mechanism: failFast cancellation is best-effort and carries NO saga — a sibling
mid-step observes cancellation only at its next checkpoint. Source:
`docs/authoring/child-workflows.mdx` (warning callout).

See also: `durable-transports-stores` — claim/stall semantics behind these nets.
See also: `durable-cluster` — where bodies actually execute in a fleet.

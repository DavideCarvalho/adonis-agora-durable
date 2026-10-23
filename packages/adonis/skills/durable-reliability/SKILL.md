---
name: durable-reliability
description: >-
  Recover and harden @adonis-agora/durable runs: step retries with fixed/exp
  backoff and jitter, FatalError and worker retryable:false, timeoutMs liveness
  vs the durable suspend path, pickupTimeoutMs, log.heartbeat, saga
  compensation (compensate callbacks/refs, UndoOf, compensationRetries,
  cancel({compensate:true})), flow-control queues (config queues / registerQueue, concurrency,
  rateLimit, fairnessKey) with Redis-backed global admission (admission-redis),
  the dead-letter queue (maxRecoveryAttempts, deadLetterWorkflow, deadLetter()
  method, onDead, retryWithInput), retention (maxAge/maxCount policies), the
  stuck-run playbook (stranded signature, redispatchPending,
  remoteRedispatchMs, remoteAdvanceSilenceMs for remote workflow turns), ace ops commands (durable:work/runs/retry --stale), and
  the testing harness (createTestEngine, tick, failOnce, conformance kits).
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.51.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/reliability/retries.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/sagas.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/dead-letter.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/flow-control.mdx'
  - 'DavideCarvalho/adonis-durable:docs/reliability/retention.mdx'
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
import { FatalError, defineStep } from '@adonis-agora/durable'

export const chargeCard = defineStep(
  'payments:charge-card',
  async (input: { orderId: number; amountCents: number }) => {
    const res = await stripe.charge(input)
    if (res.declined) {
      // deterministic verdict — don't make the engine retry it
      throw new FatalError('card declined', 'declined')
    }
    return { chargeId: res.id }
  },
  { retries: 4, backoff: 'exp', backoffMs: 500, backoffMaxMs: 30_000, jitter: true },
)
```

`FatalError` carries `retryable: false`, which the step result builders read; a
worker in another runtime gets the same effect by throwing any error with
`retryable: false` (and an optional `code`). A dispatched step WITHOUT `timeoutMs` takes the durable path: failure → persist
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
`engine.cancelWhere(filter, { compensate: true })`. The cancel is durable (a
`cancel:<runId>` marker) and honored on every exit of the turn running when it
lands: return, throw, continue-as-new or suspend all compensate and settle
`cancelled`. Every undo surfaces as a visible `compensate:<step>` event.
Source: `docs/reliability/sagas.mdx`.

### Pattern 2 — flow-control queues + fleet-wide admission

Cap concurrency/rate durably — a blocked call re-suspends with a persisted
`retryAt`, driven by the timer poller (nothing waits in memory):

```ts title="config/durable.ts"
queues: [{ name: 'emails', concurrency: 10, rateLimit: { limit: 1000, periodMs: 3_600_000 } }],
// or at runtime: engine.registerQueue({ name: 'emails', … }) — same shape, replaces a same-named one
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
status into a handler workflow — the engine starts it as `dlq:<runId>`
(idempotent) with a `DeadLetter` input `{ deadRunId, workflow, input, error }`
in the dead run's namespace. A run
whose remote step is still in flight is parked `suspended`, never counted, and a
retry (`requeue` / `durable:retry`) of a `dead`/`failed` run resets
`recoveryAttempts` to 0:

```ts title="config/durable.ts"
export default defineConfig({
  // …
  maxRecoveryAttempts: 5, // then dead-letter instead of crash-looping
})
```

```ts title="app/workflows/pipeline_workflow.ts"
export default class PipelineWorkflow extends BaseWorkflow {
  static workflow = { name: 'pipeline', version: '1' }
  async run(ctx: WorkflowCtx, input: PipelineInput) { /* … */ }
  // registered as `pipeline.dlq`; shares this instance's injected services
  async deadLetter(ctx: WorkflowCtx, dl: DeadLetter<PipelineInput>) { /* alert, ticket */ }
}
```

Precedence: inline `deadLetter()` > per-workflow `deadLetterWorkflow`
(`static workflow` / `register` / `registerRemote` option) > config
`deadLetterWorkflow` (fleet default). Declaring both a method and the option
throws. A `dlq:` handler run that dies is not routed again; a failed start
(handler not registered) is `console.warn`-ed. `engine.onDead(run => …)` still
fires first and is the manual escape hatch (keep the `dlq:<runId>` id).

A dead run stays inspectable and retriable (`durable:retry <runId>`, dashboard
retry, or `engine.retryWithInput(runId, fixedInput)` for bad data).
Source: `docs/reliability/dead-letter.mdx`.

Retention bounds terminal history (swept by `durable:work`, once a minute,
`onEvict` archives first). Scoped policies take `maxAge`, `maxCount` (keep the N
newest by start time within the scope; `0` deletes all matching), or both (most
restrictive wins); a policy with neither fails boot:

```ts title="config/durable.ts"
retention: {
  completed: '30d',
  policies: [{ statuses: ['completed', 'failed'], maxCount: 200, scope: { namespace: 'acme' } }],
},
```

Source: `docs/reliability/retention.mdx`.

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
import type { HttpContext } from '@adonisjs/core/http'
import { DEFAULT_STALE_MS, attachLiveness, filterStale, listRuns } from '@adonis-agora/durable'
import engine from '@adonis-agora/durable/services/main'

export default class OpsController {
  async strandedRuns({ response }: HttpContext) {
    const runs = await listRuns(engine, { statuses: ['running', 'suspended'], limit: 200 })
    const stale = filterStale(await attachLiveness(engine, runs), DEFAULT_STALE_MS)
    return response.ok({ stranded: stale.map(({ run }) => run.id) })
  }
}
```

Three nets, in preference order:
1. Per-step `timeoutMs` (+ heartbeat-aware liveness; split queue wait with
   `pickupTimeoutMs`) — but its timer dies with the coordinating process.
2. Engine-level `remoteRedispatchMs` / `remoteRedispatchMax` (default bound 10;
   fails the step with `RemoteStepError` code `'remote_step_lost'` beyond it) —
   must exceed the longest legitimate step; steps must be idempotent. It leases
   the pending checkpoint (`wakeAt`), a worker's heartbeat RENEWS that lease, and
   it covers a polyglot `call` fan-out (`ctx.gather_calls`) as well as `ctx.step`.
3. `engine.redispatchPending(runId)` — the operator escape hatch, safe on a
   healthy run (only touches already-pending checkpoints).

Remote (polyglot) workflow TURNS have their own net: `remoteAdvanceSilenceMs`
(config; `RemoteWorkflowExecutor`'s `timeoutMs` per workflow, shorter wins). The
engine records the turn's random `taskId` on the run (`awaitingDecisionTaskId`),
releases the lease, then enqueues; whichever replica consumes the decision
applies it by run id (stale/duplicate decisions dropped), so a point-to-point
`<P>-decisions` queue across replicas is safe. That is 0.51+: before 0.51 a
replica that had not dispatched the turn consumed the decision, found no waiter
and dropped it, leaving the run leased forever — upgrade any multi-replica fleet
running remote (Python/NestJS) workflows. A turn with no decision and no
run-scoped heartbeat (`{ runId, seq: 0, group }`, sent every 5s by the Python
and TS workers) for the window is re-dispatched by the timer poller — never
failed. Unset = wait for the decision forever. Source:
`docs/reliability/multi-instance.mdx` (remote workflow turns).

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
`runStateStoreContract(name, factory)`,
`runAdmissionBackendContract(name, factory)` and
`runRunDispatchContract(name, factory)` (transports with a run queue: `dispatchRuns` + `onDispatchedRun`) live on
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
// or read the store: listRuns(engine, { statuses: ['running', 'suspended'] })
```

Mechanism: `run.suspended` fires on EVERY park — each sleep, signal wait, child
wait — and suspended runs have not completed; counting starts minus completions
treats every parked run as finished-or-inflight incorrectly either way. The docs
warn: "Never count run.started against run.completed to infer 'runs in flight'".
Source: `docs/observability/events-and-interceptors.mdx`.

### MEDIUM reading an empty `workerHealth()` as a healthy fleet

Wrong:

```ts
const stalled = (await engine.workerHealth()).some((g) => g.stalled) // always false where no group health is reported (eventEmitter, queue with workerKeys: false)
```

Correct:

```ts
const stale = filterStale(
  await attachLiveness(engine, await listRuns(engine, { statuses: ['running', 'suspended'], limit: 200 })),
  DEFAULT_STALE_MS,
)
```

Mechanism: only `bullmq`, `queue` (with a worker-key store) and `db` report group
health — on `eventEmitter`, or `queue` with `workerKeys: false`,
`workerHealth()` returns `[]`, not an error, so "no stalled groups reported" says
nothing. On `queue`, `depth` counts pending jobs only; on `db`, pending + claimed rows. Use the stranded-signature query instead. Source:
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

---
name: durable-linting
description: >-
  Wire @adonis-agora/durable-eslint-plugin into an ESLint flat config and read
  its reports: no-nondeterminism (Date.now, performance.now, new Date(),
  Date(), Math.random, crypto.randomUUID / imported randomUUID, process.env),
  rethrow-control-flow-signals (catch blocks must rethrow
  isWorkflowControlFlowSignal errors), no-io-in-workflow-body (global fetch,
  raw engine.* calls), the recommended preset, and how the rules scope to a
  workflow body (engine.register function form, BaseWorkflow run method) and
  stop at ctx.localStep / ctx.task / ctx.sideEffect callbacks. Use when adding
  determinism linting to an app or fixing one of these lint reports.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable-eslint-plugin"
  library_version: "1.0.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/tooling/linting.mdx'
  - 'DavideCarvalho/adonis-durable:packages/eslint-plugin/README.md'
  - 'DavideCarvalho/adonis-durable:packages/eslint-plugin/src/index.ts'
  - 'DavideCarvalho/adonis-durable:packages/eslint-plugin/src/workflow-body.ts'
---

# Determinism linting

A durable workflow body is replayed from its checkpoints on every resume, so a
clock read, random value, env read, swallowed control-flow signal or direct I/O
in the body diverges on replay. The engine catches drift late, as a
`NonDeterminismError` at replay time; this plugin catches it at author time, in
the editor and CI, at the offending line.

## Setup

```bash
npm i -D @adonis-agora/durable-eslint-plugin
```

The only peer is `eslint` (`^8.57`, `^9` or `^10`); the rules are flat-config
only and take no options.

```js title="eslint.config.js"
import durable from '@adonis-agora/durable-eslint-plugin'

export default [durable.configs.recommended]
```

The preset registers the plugin under the `@adonis-agora/durable` namespace and
turns all three rules on at `error`. It carries no `files` glob, so it applies to
whatever your other config objects match. To pick rules or scope them, wire it by
hand:

```js title="eslint.config.js"
import durable from '@adonis-agora/durable-eslint-plugin'

export default [
  {
    files: ['app/**/*.ts'],
    plugins: { '@adonis-agora/durable': durable },
    rules: {
      '@adonis-agora/durable/no-nondeterminism': 'error',
      '@adonis-agora/durable/rethrow-control-flow-signals': 'error',
      '@adonis-agora/durable/no-io-in-workflow-body': 'error',
    },
  },
]
```

Besides the default export, the package exports `rules`, `configs` and the rule
objects `noNondeterminism`, `rethrowControlFlowSignals`, `noIoInWorkflowBody`.
Source: `packages/eslint-plugin/src/index.ts`.

## Core patterns

### Pattern 1 — what counts as a workflow body

Every rule fires only inside a workflow body, so enabling them on `**/*.ts` has
no false positives in controllers, services or step handlers:

- **Function form**: the function passed to `.register(name, version, fn)`,
  `.registerRemote(...)` or `.registerEntity(...)` when the receiver's name
  contains `engine` (case-insensitive: `engine`, `workflowEngine`,
  `this.engine`). `someRegistry.register(...)` is ignored.
- **Class form**: the `run` method of a class that `extends BaseWorkflow` or
  declares `static workflow = { … }`.

The walk stops at a callback passed to `ctx.localStep(...)`, `ctx.task(...)` or
`ctx.sideEffect(...)`: that body runs once and its result is checkpointed, so a
`Date.now()`, `fetch()` or `try/catch` inside it is fine. `ctx.step` is **not**
a boundary — its second argument is data for a dispatched step.
Source: `packages/eslint-plugin/src/workflow-body.ts`.

### Pattern 2 — fixing `no-nondeterminism` reports

| Flagged | Use instead |
| --- | --- |
| `Date.now()`, `performance.now()` | `await ctx.now()` |
| `new Date()` (no args), `Date()` | `new Date(await ctx.now())` |
| `Math.random()` | `await ctx.sideEffect(() => Math.random())` |
| `crypto.randomUUID()`, imported `randomUUID` | `await ctx.sideEffect(() => randomUUID())` |
| `process.env` reads | `await ctx.sideEffect(() => process.env.X)`, or resolve config outside the workflow |

```ts title="app/workflows/checkout_workflow.ts"
import { randomUUID } from 'node:crypto'
import { BaseWorkflow } from '@adonis-agora/durable'
import type { WorkflowCtx } from '@adonis-agora/durable'

export default class CheckoutWorkflow extends BaseWorkflow {
  static workflow = { name: 'checkout', version: '1' }

  async run(ctx: WorkflowCtx, order: { id: number }) {
    const startedAt = await ctx.now()
    const idempotencyKey = await ctx.sideEffect(() => randomUUID())
    return { orderId: order.id, startedAt, idempotencyKey }
  }
}
```

The rule also sees `globalThis.crypto.randomUUID()`, `import { randomUUID as
uuid }`, default/namespace `crypto` imports, and a same-file
`const d = Date; d.now()` alias. It does no data-flow analysis beyond that: a
helper function that calls `Date.now()` is invisible to it, and only the runtime
`NonDeterminismError` catches that. Source:
`packages/eslint-plugin/src/no-nondeterminism.ts`.

### Pattern 3 — the control-flow signal guard

Suspending operations unwind the turn by throwing a control-flow signal. A
`catch` around awaited code in the body must let it through:

```ts
import { isWorkflowControlFlowSignal } from '@adonis-agora/durable'
import type { WorkflowCtx } from '@adonis-agora/durable'

async function charge(ctx: WorkflowCtx, input: { orderId: number }) {
  try {
    await ctx.step('payments:charge-card', input)
  } catch (error) {
    if (isWorkflowControlFlowSignal(error)) throw error
    await ctx.step('payments:refund', input)
    throw error
  }
}
```

`rethrow-control-flow-signals` accepts that guard as the catch's first-level
`if` (also inside `isWorkflowControlFlowSignal(e) || …`) or an unconditional
`throw e`, and offers an editor suggestion that inserts the guard. A `try` over
purely synchronous code is not reported (it cannot catch a signal), and a
`catch {}` with no binding over awaited code is always reported because it
cannot rethrow.
Source: `packages/eslint-plugin/src/rethrow-control-flow-signals.ts`.

## Common mistakes

### HIGH treating `ctx.step` as a safe place for a raw read

Wrong:

```ts no-check
await ctx.step('audit:log', { at: Date.now() }) // still flagged: the argument is evaluated in the body
```

Correct:

```ts no-check
await ctx.step('audit:log', { at: await ctx.now() })
```

Mechanism: only `localStep` / `task` / `sideEffect` callbacks are checkpoint
boundaries; `ctx.step`'s input is computed in the replayed body, so the value
differs on every replay. Source: `packages/eslint-plugin/src/workflow-body.ts`.

### HIGH a bare `catch` that swallows the suspend signal

Wrong:

```ts no-check
try {
  await ctx.waitForSignal(`approve:${order.id}`)
} catch {
  return { status: 'rejected' }
}
```

Correct:

```ts no-check
try {
  await ctx.waitForSignal(`approve:${order.id}`)
} catch (error) {
  if (isWorkflowControlFlowSignal(error)) throw error
  return { status: 'rejected' }
}
```

Mechanism: the wait suspends by throwing; the bare catch turns that into the
failure path, records extra commands, and the resumed replay dies with
`NonDeterminismError`. Source: `docs/tooling/linting.mdx`.

### MEDIUM expecting the I/O rule to catch every engine call

`no-io-in-workflow-body` flags only the global `fetch(...)` and calls on a
receiver named exactly `engine` (`engine.start(...)`). `this.fetch(...)`,
`api.fetch(...)`, `this.engine.x()` and `workflowEngine.x()` are deliberately
not flagged. Wrap I/O in `await ctx.localStep('name', () => fetch(url))` and use
`ctx` primitives (`ctx.step`, child workflows) instead of driving the engine
from the body. Source: `packages/eslint-plugin/src/no-io-in-workflow-body.ts`.

See also: `durable-determinism` (in `@adonis-agora/durable`) — why the body must
be deterministic, `ctx.patched` and version bumps once runs are in flight.

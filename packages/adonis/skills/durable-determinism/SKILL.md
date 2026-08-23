---
name: durable-determinism
description: >-
  Keep @adonis-agora/durable runs replay-safe: the determinism rule (no
  Date.now, Math.random, new Date, crypto.randomUUID in a workflow body), the
  checkpointed ctx.now() and ctx.sideEffect() capture sources,
  NonDeterminismError at replay time, workflow versions for breaking shape
  changes (skew protection), ctx.patched for surgical in-place guards, and the
  @adonis-agora/durable-eslint-plugin no-nondeterminism rule with its
  recommended preset. Use when authoring or changing workflow code that has
  runs in flight, fixing NonDeterminismError, or wiring determinism linting.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/concepts/durability.mdx'
  - 'DavideCarvalho/adonis-durable:docs/authoring/versioning.mdx'
  - 'DavideCarvalho/adonis-durable:docs/tooling/linting.mdx'
---

# Determinism, replay & versioning

Durability is **checkpoint + deterministic replay**: each step records its
result at a deterministic position (`seq`); recovery re-runs the body from the
top and completed steps return their saved output instead of executing. The one
rule: the workflow body must take the same path every time it runs — all
non-determinism (network, queries, clocks, randomness) lives inside steps or
the context's capture primitives.

## Setup

Use the deterministic sources instead of raw clocks/entropy — each captures its
value once and replays it verbatim:

```ts
engine.register('invoice', '1', async (ctx, order: Order) => {
  const issuedAt = await ctx.now() // epoch ms — captured once, replayed verbatim
  const nonce = await ctx.sideEffect(() => crypto.randomUUID()) // any generated value
  const sampled = (await ctx.sideEffect(() => Math.random())) < 0.1

  await ctx.localStep('issue', () => issue(order, { issuedAt, nonce, sampled }))
})
```

`ctx.now()` is the deterministic wall clock; `ctx.sideEffect(fn)` runs `fn` once
and replays the recorded result without re-running it — wrap UUIDs, randomness,
env reads, anything non-deterministic you control. Raw `Date.now()` /
`crypto.randomUUID()` belong only inside step bodies, whose whole result is
checkpointed.

## Core patterns

### Pattern 1 — catch drift at author time with the ESLint plugin

`@adonis-agora/durable-eslint-plugin` flags `Date.now()`, `performance.now()`,
`new Date()` (no args), `Math.random()` and `crypto.randomUUID()` inside a
workflow body — AST-scoped to the function form (`engine.register(...)`) and the
class form (`BaseWorkflow.run` / any class with `static workflow`). It stops at
`ctx.localStep(...)` / `ctx.task(...)` / `ctx.sideEffect(...)` callback
boundaries, where such calls are fine.

```bash
npm i -D @adonis-agora/durable-eslint-plugin
```

```js title="eslint.config.js"
import durable from '@adonis-agora/durable-eslint-plugin'

export default [
  {
    files: ['**/*.ts'],
    plugins: { '@adonis-agora/durable': durable },
    rules: {
      '@adonis-agora/durable/no-nondeterminism': 'error',
    },
  },
]

// or simply:
// export default [durable.configs.recommended]
```

Each report names its replacement ("use `ctx.now()`"). The plugin is the cheap
early layer; `NonDeterminismError` is the replay-time backstop for calls it
cannot see (transitive helpers). Source: `docs/tooling/linting.mdx`.

### Pattern 2 — breaking changes: register versions side by side

A run records the code version it started on (`workflowVersion`) and replays on
that version. For a structural change (new/removed/reordered steps, different
control flow), bump the version and drain the old:

```ts
engine.register('checkout', '1', async (ctx, order: Order) => {
  /* original body — keep registered until its in-flight runs drain */
})

engine.register('checkout', '2', async (ctx, order: Order) => {
  /* new body */
})
```

In-flight v1 runs finish on v1; new starts pick v2. A run whose version is no
longer registered fails loudly rather than corrupting. Remove v1 only after
every run that started under it reached a terminal state.
Source: `docs/authoring/versioning.mdx`, `docs/concepts/durability.mdx`.

### Pattern 3 — surgical changes: `ctx.patched(id)`

For a small in-place change on a live workflow, guard it instead of shipping a
whole second body:

```ts
engine.register('checkout', '1', async (ctx, order: Order) => {
  const quote = await ctx.localStep('quote', () => price(order))

  if (await ctx.patched('add-fraud-check')) {
    // Runs started AFTER this code shipped take this branch...
    const risk = await ctx.step(scoreFraud, { orderId: order.id })
    if (risk.score > 0.9) throw new FatalError('high fraud risk', 'fraud')
  }
  // ...runs already recorded under the old code rewind past the marker here.

  await ctx.step(chargeCard, { orderId: order.id, amountCents: quote.total })
})
```

The marker is position-transparent: old runs replay straight into the real step
they recorded; fresh runs record `patch:add-fraud-check` and take the new branch.
Once everything old drained, delete the guard and keep the new branch.
Source: `docs/authoring/versioning.mdx`.

### Pattern 4 — what triggers the runtime guard

Replay pairs each position with its recorded checkpoint by name. If the name at
a position changed — an insert, removal, reorder — the engine throws rather than
silently mis-pairing:

```text
NonDeterminismError(runId, seq)
```

It tells you a code change is incompatible with runs that started under the old
code — fix with versions (Pattern 2) or patches (Pattern 3).
Source: `docs/authoring/versioning.mdx`.

## Common mistakes

### CRITICAL reading clocks or randomness in the orchestration prefix

Wrong:

```ts
const startedAt = Date.now()
const idempotencyKey = crypto.randomUUID()
const jitter = Math.random()
const at = new Date()
```

Correct:

```ts
const startedAt = await ctx.now()
const idempotencyKey = await ctx.sideEffect(() => crypto.randomUUID())
const jitter = await ctx.sideEffect(() => Math.random())
const at = new Date(await ctx.now())
```

Mechanism: each banned call returns a different value on every replay, so the
replayed path diverges from the recorded one and silently corrupts the run until
`NonDeterminismError` fires far from the offending line. Source:
`docs/tooling/linting.mdx`, `docs/concepts/durability.mdx`.

### HIGH reshaping a live workflow without a version bump

Wrong:

```ts
// v1 was [quote, charge]; edited in place to [quote, fraudCheck, charge]
static workflow = { name: 'checkout', version: '1' }
```

Correct:

```ts
static workflow = { name: 'checkout', version: '2' } // alongside v1 until drained
```

Mechanism: replay is positional — inserting/reordering steps while runs are in
flight pairs old checkpoints with new positions and throws
`NonDeterminismError`; the version split is exactly the skew protection for it.
Source: `docs/authoring/versioning.mdx`.

### HIGH calling injected services directly from `run`

Wrong:

```ts
async run(ctx, input) {
  const receipt = await this.billing.charge(input) // unchecked I/O, re-runs on replay
}
```

Correct:

```ts
async run(ctx, input) {
  const receipt = await ctx.step(this.billing.charge, input)
}
```

Mechanism: constructor DI resolves services outside the checkpoint system;
calling them from the body performs I/O that re-executes on every replay and is
never checkpointed. Source: `docs/authoring/app-workflows.mdx` (warning).

### MEDIUM adding `timeoutMs` to a webhook wait as an unversioned edit

Wrong:

```ts
const r = await hook.wait({ timeoutMs: 1_800_000 }) // edited onto a live workflow
```

Correct:

```ts
// Ship under version+1, or gate with ctx.patched('add-wait-deadline').
const r = await hook.wait({ timeoutMs: 1_800_000 })
```

Mechanism: a deadline claims an extra logical position, so toggling it shifts
positions for in-flight runs — the docs call it "a versioned change" explicitly.
Source: `docs/authoring/webhooks.mdx`.

### MEDIUM reading env/config directly in the body

Wrong:

```ts
const region = env.get('REGION') // may differ between the original run and a replay
if (region === 'eu') await ctx.step(gdprStep, input)
```

Correct:

```ts
const region = await ctx.sideEffect(() => env.get('REGION'))
```

Mechanism: an env value changed between the first execution and a replay makes
the body branch differently, diverging from recorded history; captured via
`sideEffect`, the value is fixed once. Source: `docs/authoring/versioning.mdx`
("a config/env read" belongs behind `ctx.sideEffect`).

See also: `durable-workflows` — the authoring surface these rules constrain.
See also: `durable-reliability` — poison-pill runs and the DLQ path when
NonDeterminismError keeps crashing recovery.

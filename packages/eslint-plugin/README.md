# @adonis-agora/durable-eslint-plugin

ESLint rules enforcing **workflow determinism** for [`@adonis-agora/durable`](../adonis). A durable workflow
body is replayed from its checkpoints on every resume, so any non-deterministic source read directly
in the orchestration body (rather than recorded once inside a `ctx.step`) silently corrupts the run.
This plugin flags them.

## Install

```sh
npm i -D @adonis-agora/durable-eslint-plugin
```

## Usage (flat config)

```js
// eslint.config.js
import durable from '@adonis-agora/durable-eslint-plugin';

export default [durable.configs.recommended];
```

Or wire it manually:

```js
import durable from '@adonis-agora/durable-eslint-plugin';

export default [
  {
    plugins: { '@adonis-agora/durable': durable },
    rules: {
      '@adonis-agora/durable/no-nondeterminism': 'error',
      '@adonis-agora/durable/rethrow-control-flow-signals': 'error',
      '@adonis-agora/durable/no-io-in-workflow-body': 'error',
    },
  },
];
```

## Rules

All rules are **AST-scoped to a workflow body** — both the function form
(`engine.register('wf', '1', async (ctx) => { … })` / `registerRemote` / `registerEntity`) and a
workflow class's `run` method (a `BaseWorkflow` subclass / `static workflow` config). Code inside a
`ctx.localStep(...)` / `ctx.task(...)` / `ctx.sideEffect(...)` callback is **never** flagged: a
checkpointed body runs once and is replayed from its recorded result.

### `no-nondeterminism`

Disallows non-deterministic sources inside a durable workflow body:

| Flagged                | Use instead              |
| ---------------------- | ------------------------ |
| `Date.now()`           | `ctx.now()`              |
| `performance.now()`    | `ctx.now()`              |
| `new Date()`           | `new Date(await ctx.now())` |
| `Date()` (plain call)  | `new Date(await ctx.now())` |
| `Math.random()`        | `ctx.sideEffect(() => Math.random())` |
| `crypto.randomUUID()`  | `ctx.sideEffect(() => crypto.randomUUID())` |
| imported `randomUUID` from `node:crypto` (incl. `import { randomUUID as uuid }`) | `ctx.sideEffect(() => randomUUID())` |
| `process.env` reads    | `ctx.sideEffect(() => process.env.X)` or resolve config outside the workflow |

Cheap aliases are tracked too: `const d = Date; d.now()` is flagged when the `const` is assigned
from the banned global in the same file (no data-flow analysis beyond that).

### `rethrow-control-flow-signals`

A `try/catch` inside a workflow body must let the engine's control-flow signals (suspend /
continue-as-new) through — they unwind the current turn by throwing and are **not** real failures.
A catch that swallows one breaks suspension silently and corrupts the run's history. The rule
reports a catch clause over awaited code unless it either starts a guard like
`if (isWorkflowControlFlowSignal(e)) throw e` (exported by `@adonis-agora/durable`) or rethrows the
caught error unconditionally — and offers a suggestion inserting the guard as the first statement.

### `no-io-in-workflow-body`

Disallows direct I/O in the orchestration body, which re-executes on every replay: global
`fetch(...)` calls (`this.fetch(...)` and other receivers are left alone) and raw `engine.*` calls
(receiver named exactly `engine`). Wrap the I/O in a checkpointed step
(`await ctx.localStep('name', () => fetch(…))`) or drive the engine from outside the workflow.

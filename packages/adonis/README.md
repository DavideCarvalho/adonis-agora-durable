# `@adonis-agora/durable`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![CI](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable)

Durable, resumable workflows for AdonisJS: write a workflow as plain async code; every step is
checkpointed, so a run survives crashes and deploys and resumes from its last completed step.
Steps can run in-process or on remote workers (another Adonis process, a NestJS worker, or a
Python worker), and it stays one run with one timeline.

```sh
node ace add @adonis-agora/durable
```

Define a workflow under `app/workflows/` (auto-registered at boot):

```ts
// app/workflows/order_workflow.ts
import { BaseWorkflow, type WorkflowCtx } from '@adonis-agora/durable'

export default class OrderWorkflow extends BaseWorkflow {
  static workflow = { name: 'order', version: '1' }

  async run(ctx: WorkflowCtx, order: { id: number; total: number }) {
    const charge = await ctx.localStep('charge', async () => chargeCard(order))
    await ctx.localStep('ship', async () => ship(charge))
    return { status: 'shipped' }
  }
}
```

Start it from a controller, and use the engine service for everything else:

```ts
import OrderWorkflow from '#workflows/order_workflow'
import engine from '@adonis-agora/durable/services/main'

const { runId } = await OrderWorkflow.dispatch({ id: 1, total: 4200 }, { runId: 'order:1' })
const result = await engine.waitForRun(runId)
```

Defaults to the in-memory store + the test-only `memory` transport (single process, zero infra).
Supply a persistent store and a cross-process transport in `config/durable.ts` for production.
When `@adonis-agora/context` is installed, the originating tenant/user/correlation carrier rides
each dispatched task (best-effort, no hard dependency).

Full docs: https://davidecarvalho.github.io/agora/docs/durable

## Transports

Select a transport by name in `config/durable.ts`:

- `transports.eventEmitter()` — **production in-process** transport over a Node
  `EventEmitter`. Zero external infrastructure (no DB, no Redis, no broker): step
  handlers run in this same process, decoupled from the dispatching workflow over
  the event loop. Use it for a single-process production app.
- `transports.queue({ connection })` — cross-process over `@adonisjs/queue`.
- `transports.db({ connection })` — cross-process over the app database
  (`@adonisjs/lucid`), no broker.
- `transports.bullmq({ connection })` — cross-process over BullMQ on Redis, wire-compatible
  with the NestJS (`nestjs-durable`) BullMQ transport and the Python worker. Pair it with
  `controlPlanes.redis(...)`.
- `transports.memory()` — test-only (drives `dispatch` straight into the handler).

```ts
import { defineConfig, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'event-emitter',
  transports: {
    'event-emitter': transports.eventEmitter(),
  },
})
```

## Workflows codegen (Assembler hook)

`node ace configure` registers two AdonisJS **Assembler `init` hooks** that generate
typed barrels of `app/workflows/` and `app/steps/` at build/dev time — exactly how core generates
the controllers/events/listeners barrels. The provider imports the generated
barrels at boot and registers every `BaseWorkflow` class and step, instead of scanning
the directories with `readdir` at runtime. The file watcher regenerates a barrel
whenever a workflow or step file changes. The barrels import through the `#workflows/*`
and `#steps/*` subpath imports, which `configure` adds to your `package.json`.

Register it in `adonisrc.ts` (the `configure` command does this for you):

```ts
export default defineConfig({
  hooks: {
    init: [
      () => import('@adonis-agora/durable/hooks/workflows'),
      () => import('@adonis-agora/durable/hooks/steps'),
    ],
  },
})
```

If the hook is not registered (or the barrel hasn't been generated yet) the
provider **falls back** to the runtime directory scan, so apps that don't opt in
keep working unchanged. Opt out of discovery entirely with `workflowsPath: false`
(or `stepsPath: false`).

A modular app can list several directories: `workflowsPath` / `stepsPath` take
an array, and so does the hooks' `source` option. Names must be unique across
those directories, and a clash fails boot naming both files.

## License

MIT © Davi Carvalho

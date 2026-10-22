# `@adonis-agora/durable`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![CI](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable)

AdonisJS binding for [`@adonis-agora/durable-core`](https://www.npmjs.com/package/@adonis-agora/durable-core)
— a container-resolved durable workflow engine.

```sh
npm i @adonis-agora/durable
node ace configure @adonis-agora/durable
```

```ts
import { WorkflowEngine } from '@adonis-agora/durable'

const engine = await app.container.make(WorkflowEngine)
engine.register('order', '1', async (ctx) => {
  const charge = await ctx.step('charge', () => chargeCard(ctx.input))
  await ctx.step('ship', () => ship(charge))
})
await engine.start('order', input, runId)
```

Defaults to an in-process store + transport (single-process, zero infra). Supply a
persistent store and a broker-backed transport in `config/durable.ts` for
production. When `@adonis-agora/context` is installed, the originating tenant/user/
correlation carrier rides each dispatched task (best-effort, no hard dependency).

## Transports

Select a transport by name in `config/durable.ts`:

- `transports.eventEmitter()` — **production in-process** transport over a Node
  `EventEmitter`. Zero external infrastructure (no DB, no Redis, no broker): step
  handlers run in this same process, decoupled from the dispatching workflow over
  the event loop. Use it for a single-process production app.
- `transports.queue({ connection })` — cross-process over `@adonisjs/queue`.
- `transports.db({ connection })` — cross-process over the app database
  (`@adonisjs/lucid`), no broker.
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

`node ace configure` registers an AdonisJS **Assembler `init` hook** that generates
a typed barrel of `app/workflows/` at build/dev time — exactly how core generates
the controllers/events/listeners barrels. The provider imports the generated
`.adonisjs/durable/workflows.ts` at boot and registers every `BaseWorkflow` class,
instead of scanning the directory with `readdir` at runtime. The file watcher
regenerates the barrel whenever a workflow file changes.

Register it in `adonisrc.ts` (the `configure` command does this for you):

```ts
export default defineConfig({
  hooks: {
    init: [() => import('@adonis-agora/durable/hooks/workflows')],
  },
})
```

If the hook is not registered (or the barrel hasn't been generated yet) the
provider **falls back** to the runtime directory scan, so apps that don't opt in
keep working unchanged. Opt out of discovery entirely with `workflowsPath: false`.

A modular app can list several directories: `workflowsPath` / `stepsPath` take
an array, and so does the hooks' `source` option. Names must be unique across
those directories, and a clash fails boot naming both files.

## License

MIT © Davi Carvalho

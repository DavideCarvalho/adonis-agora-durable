# Pinning a step to a transport, and failover pools

Source: `docs/transports/index.mdx`.

`transports` is a menu. `transport` is where steps go; `transportPool` lists the
transports built at boot as its failover, in order. A step pins ANY key of
`transports` by name; one not built yet is built the first time a step pins it
(same deferral, namespace, result consumption and shutdown as the pool), and joins
the pool after it, so unpinned failover is unchanged:

```ts
import { defineConfig, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'queue',
  transportPool: ['db'], // failover for every step, built at boot
  transports: {
    queue: transports.queue({ connection: 'redis' }),
    db: transports.db(),
    bullmq: transports.bullmq({ connection: 'redis' }), // built on first pin
  },
})

// in a workflow:
// await ctx.step(heavyStep, input, { transport: 'bullmq' })
```

A pinned step records its transport on the `pending` checkpoint, so a restarted
process builds it at boot and still consumes its results (Lucid and in-memory
stores; a custom store implements `listPendingTransports`, else list the
transport in `transportPool`). `app/steps` handlers are served only on the
primary `transport`: a pinned step goes to whatever workers consume the pinned one.

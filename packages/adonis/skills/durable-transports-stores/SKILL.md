---
name: durable-transports-stores
description: >-
  Wire @adonis-agora/durable drivers in config/durable.ts: transports
  (memory/eventEmitter/queue over @adonisjs/queue, broker-less db over Lucid,
  bullmq for cross-runtime), per-step transport pinning and failover pools,
  controlPlanes.redis broadcast channel, the lucid StateStore (published
  migration delegating to createDurableTables, autoSchema, repair warning,
  updateRunIf compare-and-set), CodecStateStore payload encryption with a
  PayloadCodec, and namespace vs partition isolation. Use when moving steps
  across processes, persisting runs durably, sharing one database/broker
  between pools, or encrypting payloads at rest.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/transports/index.mdx'
  - 'DavideCarvalho/adonis-durable:docs/transports/queue.mdx'
  - 'DavideCarvalho/adonis-durable:docs/transports/db.mdx'
  - 'DavideCarvalho/adonis-durable:docs/transports/control-plane.mdx'
  - 'DavideCarvalho/adonis-durable:docs/stores/index.mdx'
  - 'DavideCarvalho/adonis-durable:docs/stores/lucid.mdx'
---

# Transports & state stores

A transport carries a dispatched `ctx.step` to its handler and the result back;
a state store persists runs and checkpoints. They are independent pluggable,
config-selected drivers — mix any store with any transport. Drivers are named
from the `transports`/`stores` maps and lazily import their optional peer only
when selected.

## Setup

```bash
node ace configure @adonis-agora/durable   # publishes config + migrations
node ace migration:run                     # durable tables (+ db-transport tables)
```

```ts title="config/durable.ts"
import { defineConfig, stores, transports } from '@adonis-agora/durable'

export default defineConfig({
  transport: 'queue',
  transports: {
    memory: transports.memory(),
    'event-emitter': transports.eventEmitter(),
    queue: transports.queue({ connection: 'redis' }), // names a config/queue.ts adapter
    db: transports.db(), // pass { connection } for a non-default Lucid connection
  },
  store: 'lucid',
  stores: { lucid: stores.lucid() },
})
```

Switching transports is a one-line change; workflow code never changes.

## Core patterns

### Pattern 1 — cross-process steps without new infrastructure (`db`)

The `db` transport makes dispatched steps rows in the database you already run —
no Redis, no broker. Workers claim rows with an atomic portable lease (no
`FOR UPDATE SKIP LOCKED` needed):

```ts title="start/worker.ts (a separate worker process)"
import db from '@adonisjs/lucid/services/db'
import { DbTransport } from '@adonis-agora/durable'

const transport = new DbTransport({ db }) // { partition } isolates this pool
transport.handle('pipeline:extract', async (input) => extract(input))
```

Trade-off: throughput is bounded by polling + row contention — right for
workflow-scale modest rates, not high-fanout firehoses. Delivery is
at-least-once (crash between insert-result and delete-task), so handlers should
be idempotent on `step_id`. Source: `docs/transports/db.mdx`.

### Pattern 2 — real brokers (`queue`, `bullmq`) and stalled-claim tuning

The `queue` transport rides any `@adonisjs/queue` adapter defined once in
`config/queue.ts`; `bullmq` is the cross-ecosystem wire shared byte-for-byte
with NestJS engines and Python workers:

```ts title="config/durable.ts"
export default defineConfig({
  transports: {
    queue: transports.queue({
      connection: 'redis',
      // A claim is NEVER renewed while a worker processes it — its age is the
      // step's elapsed time. Raise the threshold above your longest step:
      stalledThresholdMs: 2 * 60 * 60 * 1000, // default 30min
      maxStalledCount: 3, // bounds a poison job
      onError: (err) => logger.error({ err }, 'durable queue transport'),
    }),
  },
})
```

One instance consumes engine-side results; run one or more `node ace
durable:work` workers serving the step names. Source:
`docs/transports/queue.mdx`.

### Pattern 3 — multi-replica fan-out: the control plane

The task transport is point-to-point; lifecycle events and cancellation need a
broadcast channel across every replica. Omit it and the engine is local-only
(correct for single-instance):

```ts title="config/durable.ts"
import { controlPlanes, defineConfig } from '@adonis-agora/durable'

export default defineConfig({
  // …
  controlPlane: controlPlanes.redis({ connection: 'main' }), // config/redis.ts connection
})
```

Channel is `${prefix}-control` (default prefix `durable`) — wire-compatible with
the NestJS fleet's channel, so an AdonisJS and NestJS deployment sharing one
Redis fan out across both runtimes. Source: `docs/transports/control-plane.mdx`.

### Pattern 4 — schema ownership and encryption at rest

The migration **delegates** to the library instead of snapshotting DDL, so the
schema cannot drift from what the installed version writes:

```ts title="database/migrations/…_create_durable_tables.ts"
import { BaseSchema } from '@adonisjs/lucid/schema'
import db from '@adonisjs/lucid/services/db'
import { createDurableTables, dropDurableTables } from '@adonis-agora/durable'

export default class extends BaseSchema {
  static disableTransactions = true

  async up() {
    await createDurableTables(db, this.db.connectionName)
  }

  async down() {
    await dropDurableTables(db, this.db.connectionName)
  }
}
```

By default the provider also provisions idempotently at boot (`ensureSchema`);
turn that off to own every change through reviewed migrations:

```ts
export default defineConfig({ /* … */ autoSchema: false })
// then `node ace migration:run` after EVERY package upgrade
```

Encrypt run/step/signal/event payloads by decorating any store with a codec
(searchable metadata and structured error stay plaintext):

```ts title="config/durable.ts"
import { CodecStateStore, LucidStateStore, defineConfig } from '@adonis-agora/durable'
import type { PayloadCodec } from '@adonis-agora/durable'
import db from '@adonisjs/lucid/services/db'

const aesCodec: PayloadCodec = {
  encode(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
    return { body }
  },
  decode(value) {
    return JSON.parse(Buffer.from((value as { body: string }).body, 'base64').toString('utf8'))
  },
}

export default defineConfig({
  store: 'encrypted',
  stores: { encrypted: async () => new CodecStateStore(new LucidStateStore(db), aesCodec) },
})
```

Source: `docs/stores/lucid.mdx`, `docs/stores/index.mdx`.

## Common mistakes

### HIGH setting `stalledThresholdMs` below the longest legitimate step

Wrong:

```ts
transports.queue({ connection: 'redis', stalledThresholdMs: 60_000 }) // imports take ~90min
```

Correct:

```ts
transports.queue({ connection: 'redis', stalledThresholdMs: 2 * 60 * 60 * 1000 })
```

Mechanism: a claim's age equals the step's elapsed runtime because nothing
renews it mid-processing; a threshold below the longest step redelivers jobs
from merely-slow workers and double-runs the step. For tighter detection use
per-step `timeoutMs`, which IS heartbeat-aware.
Source: `docs/transports/queue.mdx` ("Stalled-job reclaim").

### HIGH hand-copying the DDL into the migration

Wrong:

```ts
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('durable_workflow_runs', (t) => {
      /* copied column list */
    })
  }
}
```

Correct:

```ts
export default class extends BaseSchema {
  static disableTransactions = true
  async up() {
    await createDurableTables(db, this.db.connectionName)
  }
}
```

Mechanism: the snapshot is only right until the next release drifts past it, and
the two details are load-bearing — without `disableTransactions = true` a
`pool.max: 1` setup hangs until acquire timeout (createDurableTables checks out
its own connection), and `this.db` has no `.connection()` method, only
`.connectionName`. Source: `docs/stores/lucid.mdx`.

### MEDIUM leaving `autoSchema: false` with no upgrade discipline

Wrong:

```ts
export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid() }, autoSchema: false })
// …package upgraded twice, migrations never re-run
```

Correct:

```bash
node ace migration:run   # after every @adonis-agora/durable upgrade
```

Mechanism: with boot provisioning off, nothing repairs the schema; when the boot
path DOES repair (autoSchema on), it logs a one-time "repaired the durable
schema in place" warning meaning exactly this — the database was behind and the
fix was never recorded in migration history. Source: `docs/stores/lucid.mdx`
("The repair warning").

### MEDIUM using the deprecated `group` option to isolate worker pools

Wrong:

```ts
transports.db({ group: 'tenant-a' }) // silently accepted and ignored
```

Correct:

```ts
transports.db({ partition: 'tenant-a' })
```

Mechanism: routing is by handler name — an instance serves whatever names it
registers, so there is no group to declare. Isolation comes from `partition`
(suffixes routing tokens `<name>@<partition>`) plus `namespace` (scopes which
runs this engine polls). Source: `docs/transports/db.mdx` options table,
`docs/concepts/tenancy.mdx`.

### MEDIUM wrapping a store in CodecStateStore and expecting heartbeats

Wrong:

```ts
stores: { encrypted: async () => new CodecStateStore(new LucidStateStore(db), aesCodec) }
// then relying on persisted heartbeat progress for long remote steps
```

Correct: accept the documented trade-off explicitly — the decorator does not
implement the optional `recordStepHeartbeat`, so persisted liveness progress is
traded for encryption at rest (the live `step.started` event still fires).

Mechanism: the optional member list defines what decorators can silently drop;
heartbeat persistence is one of them. Source: `docs/stores/index.mdx`
(optional members table + warning).

See also: `durable-reliability` — retries/timeouts interact with transport
claim semantics; the stuck-run playbook.
See also: `durable-cluster` — namespace/partition across topologies and tenants.

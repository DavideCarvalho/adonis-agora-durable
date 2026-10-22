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
  - 'DavideCarvalho/adonis-durable:docs/cluster/interop.mdx'
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

A worker runs ONE task row at a time unless `concurrency` is raised
(`transports.db({ concurrency: 8, resultConcurrency: 8 })`, or `'adaptive'` with
the same controller and fields as `queue`/`bullmq`); one poll loop serves every
handler name and claims only as many rows as it has free slots. Every held
claim is renewed every `leaseMs / 3`, and a row is recorded (task delete +
result insert, one transaction) only while `claimed_by` is still the worker's
token — a worker whose claim was taken over drops its result and reports it to
`onError`. (Releases before this claimed 20 rows per poll, renewed only the
running one, and double-ran the rest of the batch when a step outlived
`leaseMs`.) Idle task/heartbeat/control loops back off up to `idleBackoffMax`
(default 4) poll intervals; results never back off.

Workers beat `durable[-<ns>]-worker-heartbeat:<token>:<instance>` into
`durable_transport_worker_keys` with their `WorkerStatus`, and `DbTransport`
implements `groupHealth`: `depth` = pending + claimed task rows of the group.
Each takeover of a lapsed claim bumps the row's `reclaims` column; past
`maxStalledCount` (default 3) the row is deleted and a retryable failed
`StepResult` (`remote step worker failed: claim lapsed more than N times`) is
published. `close()` (after `closeTimeoutMs`, default 5s) clears every claim it
still holds, uncounted, so another worker takes the rows at once and a deploy
never pushes a step toward the poison bound; only a crash (no close) counts.
Dispatch `priority` is stored on the row (`0` when absent = normal) and rows
are claimed highest priority first, then oldest. `autoCreate` /
`createDurableTransportTables` add `reclaims` and `priority` to an existing
table; with `autoCreate: false` add them yourself (integer, not null, default
0), or the poison bound / priority ordering stay off.

`db` also carries remote workflow turns (task rows of kind `workflow`, claimed
with the token's steps; each decision is a `durable_transport_messages` row
addressed to the engine replica that dispatched the turn, though any replica
could apply it) and store-less tenant
pods that reach the same database: start-run/run-request/step-event rows go to
any consumer, a reply is a row addressed to the requester, a tenant event is one
row per live subscriber (pods write their own `-inbox:` / `-tenant-subscriber:`
keys to `durable_transport_worker_keys`). A janitor on every instance that
addresses rows deletes those older than `inboxTtlMs` whose recipient's inbox key
is gone. Ships as the `create_durable_transport_messages` migration (also adds
the tasks `kind` column) or via `autoCreate`; without it the protocol is off and
said once through `onError`. Tune with `inboxTtlMs`, `tenantSubscribersCacheMs`,
`inboxSweepIntervalMs`. See `durable-cluster`.

Trade-off: throughput is bounded by polling + row contention — right for
workflow-scale modest rates, not high-fanout firehoses. Delivery is
at-least-once (a worker that dies after its handler ran re-runs elsewhere), so
handlers should be idempotent on `step_id`. Source: `docs/transports/db.mdx`.

### Pattern 2 — real brokers (`queue`, `bullmq`) and stalled-claim tuning

The `queue` transport rides any `@adonisjs/queue` adapter defined once in
`config/queue.ts`; `bullmq` is the cross-ecosystem wire shared byte-for-byte
with NestJS engines and Python workers:

```ts title="config/durable.ts"
export default defineConfig({
  transports: {
    queue: transports.queue({
      connection: 'redis',
      // Claims are renewed while a step runs, so this bounds worker SILENCE
      // (crash, or a blocked event loop), not step length. Default 2min:
      stalledThresholdMs: 5 * 60 * 1000,
      maxStalledCount: 3, // bounds a poison job
      onError: (err) => logger.error({ err }, 'durable queue transport'),
    }),
  },
})
```

One instance consumes engine-side results; run one or more `node ace
durable:work` workers serving the step names. A worker runs ONE job of a step
name at a time unless `concurrency` is raised (`transports.queue({ connection,
concurrency: 8, resultConcurrency: 8 })`); the slots share one poll loop.
`concurrency: 'adaptive'` (or `{ mode: 'adaptive', min, max, start, tickMs,
ramCeilingPct, cpuCeilingPct }`) runs the same controller as `bullmq` (below);
each step name's loop reads the live limit every poll. Idle
task/heartbeat/control loops back off up to `idleBackoffMax × pollIntervalMs`
(default 4 × 200ms; `1` disables).

A `queue` worker beats `<prefix>-worker-heartbeat:<token>:<instance>` into the
worker-key store (10s, live 35s) with its `WorkerStatus`, and the transport
implements `groupHealth` when a store is configured (the default with a database;
absent with `workerKeys: false`). Its `depth` is the PENDING count (`sizeOf`) only —
the adapter contract can't count jobs in flight or delayed retries. A task that
stalls past `maxStalledCount` is failed AND bridged into a retryable failed
`StepResult` (`remote step worker failed: stalled more than N times`) on
`@adonisjs/queue` 0.7; on 0.6 the adapter deletes it internally and nothing is
published, so rely on `timeoutMs` / `remoteRedispatchMs` there. Source:
`docs/transports/queue.mdx`.

`queue` also carries remote workflow turns (`<prefix>:decisions`,
`<prefix>:step-events`) and store-less tenant pods: start-run/run-request are
plain jobs to the control plane, replies go to a per-pod
`<prefix>:run-replies:<instanceId>` queue, and tenant events are pushed to each
subscribed pod's `<prefix>:tenant-events:<instanceId>` (subscriptions announced
on `<prefix>:inbox-registrations`, recorded in the control plane's key store;
tune with `inboxTtlMs`, `tenantSubscribersCacheMs`, `inboxSweepIntervalMs`).
See `durable-cluster`.

For wide fans (`ctx.all` over thousands of steps), raise how many results an
instance settles at once on `bullmq`, `queue` or `db` (`resultConcurrency`),
let its workers size their step concurrency, and size the engine's due-timer
batch:

```ts title="config/durable.ts"
export default defineConfig({
  timerBatchSize: 1000, // due runs per timer pass, most overdue first (default 500)
  transports: {
    bullmq: transports.bullmq({
      connection: { host: '127.0.0.1', port: 6379 },
      resultConcurrency: 16, // default 1
      // A number pins each task queue's concurrency (default 1). 'adaptive' moves it
      // every tickMs: +1 while steps saturate the limit at steady latency, down by the
      // latency gradient when they queue, -1 on >20% errors / a stall / the CPU ceiling,
      // -20% at ramCeilingPct of the cgroup (else host) memory limit.
      concurrency: { mode: 'adaptive', min: 1, max: 32, start: 1, tickMs: 2000, ramCeilingPct: 85 },
    }),
  },
})
```

Only step durations feed the adaptive window (workflow turns count as in-flight
work and progress); a non-finite or out-of-range field falls back to its default, and
`cpuCeilingPct` is off unless set. A number runs no control loop. The heartbeat's
throughput covers the trailing minute, decaying while the worker is idle and reading 0 once a minute passes with no completed step; with a fixed limit the heartbeat still reports `cpuPct`, sampled at most once every 2s. In adaptive mode the decisions, step-events, start-run and run-request consumers run
at 1 (results run at `resultConcurrency`). Sources: `docs/transports/index.mdx`, `docs/cluster/interop.mdx`.

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

A custom store should implement `countCheckpoints(runId, fromSeq, toSeq,
statuses)` as a `COUNT` (the step-fan join barrier calls it on every result;
without it the engine loads the run's checkpoints per result), implement
`saveCheckpointIfPending` as one conditional `UPDATE ... WHERE status = 'pending'`
(without it a blind save can put a settled step back to `pending`), and return
`listDueTimers` most overdue first, with or without a `limit`. Run
`runStateStoreContract` from `@adonis-agora/durable/testing/conformance`, which
covers all three and fails a store missing either method.

Source: `docs/stores/lucid.mdx`, `docs/stores/index.mdx`.

## Common mistakes

### HIGH blocking the event loop longer than `stalledThresholdMs`

Wrong:

```ts
// a step body that renders a report synchronously for ~3 minutes, default 2min threshold
transports.queue({ connection: 'redis' })
```

Correct:

```ts
transports.queue({ connection: 'redis', stalledThresholdMs: 5 * 60 * 1000 })
// or keep the heavy work async / off the main thread
```

Mechanism: the transport renews every in-flight claim each half threshold
(`adapter.renewJobs`), so a long but async step keeps its claim forever. A
synchronous body starves the renewal timer; once the claim goes unrenewed past
the threshold the sweep re-delivers it and the step runs twice — reported to
`onError` as `lost N of M claim(s)`. Raising the threshold to cover step LENGTH
is no longer needed (that was the pre-renewal rule).
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

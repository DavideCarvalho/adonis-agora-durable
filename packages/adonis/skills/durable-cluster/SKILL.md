---
name: durable-cluster
description: >-
  Scale @adonis-agora/durable across processes and runtimes: the
  role-discriminated config (standalone, control-plane, store-less tenant with
  compile-time store exclusion), durable:work vs durable:worker entrypoints,
  WorkerRuntime + RedisWorkerRegistry descriptors, handshake negotiation
  (compatible/degraded/incompatible) and capability routing (requires → blocked
  runs), layered tenant auth (signTenantToken/hmacTenantVerifier/verifyTenant),
  runGateway as the role-portable read/control surface, namespace vs partition,
  and Python (durable-worker) / NestJS interop over the bullmq wire. Use when
  splitting web from workers, isolating tenants, or adding polyglot workers.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/durable"
  library_version: "0.25.0"
  framework: adonisjs
sources:
  - 'DavideCarvalho/adonis-durable:docs/cluster/index.mdx'
  - 'DavideCarvalho/adonis-durable:docs/cluster/roles-and-config.mdx'
  - 'DavideCarvalho/adonis-durable:docs/cluster/thin-workers.mdx'
  - 'DavideCarvalho/adonis-durable:docs/cluster/handshake.mdx'
  - 'DavideCarvalho/adonis-durable:docs/cluster/interop.mdx'
  - 'DavideCarvalho/adonis-durable:docs/python.mdx'
  - 'DavideCarvalho/adonis-durable:docs/concepts/tenancy.mdx'
---

# Cluster topologies & interop

`config/durable.ts` is a **role-discriminated union**: one `role` field picks
the topology and TypeScript narrows the rest. Workflows (`app/workflows`) and
steps (`app/steps`) are byte-identical across every role — only where bodies
execute changes.

| Role | Owns the store | Executes bodies | Serves HTTP |
|------|:---:|:---:|:---:|
| `standalone` (default — omit `role`) | ✅ | ✅ embedded | optional |
| `control-plane` | ✅ required | ❌ | optional |
| `tenant` | ❌ typed `never` | worker pods ✅ | api/dashboard pod |

## Setup

Split fleet: a pure coordinator plus store-less tenant workers.

```ts title="config/durable.ts (control plane)"
import { defineConfig, stores, transports } from '@adonis-agora/durable'

export default defineConfig({
  role: 'control-plane',
  transport: 'bullmq', // cross-ecosystem wire; queue/db work for Adonis-only splits
  transports: { bullmq: transports.bullmq({ connection: { host: '127.0.0.1', port: 6379 } }) },
  store: 'lucid',
  stores: { lucid: stores.lucid({ connection: 'pg' }) },
  verifyTenant: hmacTenantVerifier(process.env.DURABLE_TENANT_SECRET!),
})
```

```ts title="config/durable.ts (tenant worker pod)"
import { defineConfig, transports } from '@adonis-agora/durable'

export default defineConfig({
  role: 'tenant',
  transport: 'bullmq',
  transports: { bullmq: transports.bullmq({ connection: process.env.REDIS_URL }) },
  partition: 'acme-corp', // which pool this pod serves (required)
  tenant: { token: process.env.DURABLE_TENANT_TOKEN }, // its signed claim
  requestTimeoutMs: 10_000,
  // store: 'lucid'  // ❌ COMPILE ERROR — a tenant config cannot name a store
})
```

```bash title="entrypoints"
node ace durable:work    # store-backed loop: pending, recovery, timers, sweeps, schedules
node ace durable:worker  # store-less tenant loop: serves app/steps, heartbeats, drains
```

Isolation is three-layered: type (`store` is `never` on tenant), container (no
store binding registered), object (`WorkerRuntime`/`ProxyRunGateway` have no
store field).

## Core patterns

### Pattern 1 — role-portable code via `runGateway`

Every role exposes the same read/control surface; identical controller code runs
on a store pod (direct reads) or a store-less pod (wire requests answered by the
control plane's `RunRequestResponder`):

```ts title="app/controllers/runs_controller.ts"
import { runGateway } from '@adonis-agora/durable/services/main'

export default class RunsController {
  async show({ params, response }: HttpContext) {
    const run = await runGateway.getRun(params.id)
    if (!run) return response.notFound()
    return response.ok({ run, timeline: await runGateway.getCheckpoints(params.id) })
  }

  async approve({ params, response }: HttpContext) {
    await runGateway.signal(params.id, `approve:${params.id}`, { by: 'ops' })
    return response.accepted({})
  }
}
```

Verbs: `getRun`, `listRuns`, `getCheckpoints`, `getRunChildren`,
`getSearchAttributes`, `start`, `signal`, `cancel`, `redispatchPending`,
`workerHealth`, `subscribe`, `topology()`. Never branch on `role`.
Source: `docs/cluster/roles-and-config.mdx`.

### Pattern 2 — capability-aware routing and blocked runs

A step can require capabilities; dispatch goes only to workers advertising them.
No capable live worker → the run parks **blocked** (first-class status, visible
in the dashboard, auto-resumes when a capable worker registers):

```ts
export const settlePayment = defineStep(
  'settle-payment',
  async (input: { orderId: number }) => ({ /* … */ }),
  { requires: ['saga', 'search-attributes'] },
)
```

Workers advertise a `WorkerDescriptor` (runtime, SDK version, protocol range,
capabilities, steps/workflows served, partition); the control plane negotiates
protocol-major overlap + capability intersection into compatible / degraded /
incompatible. An incompatible worker is never handed a task — structured
`protocol.incompatible` / `capability.unavailable` diagnostics carry both
descriptors and the delta. Source: `docs/cluster/handshake.mdx`.

### Pattern 3 — building a thin worker by hand

Outside an Adonis app (standalone Node service), use the `/worker` subpath — it
imports zero store code:

```ts title="worker.ts"
import { RedisWorkerRegistry, WorkerRuntime } from '@adonis-agora/durable/worker'
import { transports } from '@adonis-agora/durable'
import { Redis } from 'ioredis'

const transport = await transports.bullmq({ connection: process.env.REDIS_URL })({ app })
const runtime = new WorkerRuntime({
  transport,
  partition: 'acme-corp',
  registry: new RedisWorkerRegistry(new Redis(process.env.REDIS_URL!), { ownsConnection: true }),
})

runtime.registerStep('billing.charge', async (input, log) => {
  log.info('charging', input)
  return { chargeId: await stripe.charge(input as ChargeInput) }
})

await runtime.start()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void runtime.stop())
}
```

A worker that must execute workflow turns registers their BODIES explicitly —
synchronous replay functions returning commands. Source:
`docs/cluster/thin-workers.mdx`.

### Pattern 4 — Python workers on the same control plane

The BullMQ transport speaks the aviary wire byte-for-byte, so a Python worker
can serve steps (or whole workflows) for an AdoniJS control plane over the same
Redis:

```bash
pip install "durable-worker[redis]"
```

```python title="worker.py"
import asyncio
from durable_worker import Worker
from durable_worker.redis_runner import run_redis_worker

worker = Worker()

@worker.step("payments.charge-card")
async def charge(data):
    res = await stripe.charge(data["orderId"], data["amountCents"])
    return {"chargeId": res.id}

async def main():
    await run_redis_worker(worker, connection="redis://localhost:6379")
    await asyncio.Event().wait()

asyncio.run(main())
```

Connection and prefix must match on both sides; sharing a broker across
deployments means setting the same `partition` on both sides (queues become
`<name>@<partition>`). Start Python workflows from Adonis by name:
`engine.start('pipeline', input, id)` — if no worker serves the name, the start
fails fast rather than hanging. Source: `docs/python.mdx`,
`docs/cluster/interop.mdx`.

## Common mistakes

### HIGH launching `durable:worker` on a store-backed role

Wrong:

```bash
node ace durable:worker   # on a standalone/control-plane pod
```

Correct:

```bash
node ace durable:work     # the store-backed dispatch/recovery/timers/schedules loop
```

Mechanism: `durable:worker` boots the store-less `WorkerRuntime`; on a role that
owns a store it logs a warning and refuses — the two commands are different
topologies, not aliases. Source: `docs/cli.mdx`.

### HIGH assuming `durable:worker` pods carry workflow bodies

Wrong:

```bash
# expecting a tenant pod to execute workflow turns because app/workflows exists
node ace durable:worker
```

Correct:

```ts
runtime.registerWorkflow('checkout', (ctx, input) => {
  const paid = ctx.step('billing.charge', input)
  return { paid }
})
```

Mechanism: the command registers workflow NAMES from `app/workflows` (routing +
descriptor) but not their bodies; turn execution needs explicit registration,
and turns are synchronous replay functions by design. Source:
`docs/cluster/thin-workers.mdx` (warning callout).

### MEDIUM leaving a hand-built WorkerRuntime on the default NoopWorkerRegistry

Wrong:

```ts
const runtime = new WorkerRuntime({ transport, partition: 'acme' }) // registry defaults to noop
```

Correct:

```ts
const runtime = new WorkerRuntime({
  transport,
  partition: 'acme',
  registry: new RedisWorkerRegistry(redis, { ownsConnection: true }),
})
```

Mechanism: without a registry the descriptor/heartbeat go nowhere — the worker
executes fine but is invisible to capability-aware routing, so any step with
`requires` will never be dispatched to it. Source:
`docs/cluster/thin-workers.mdx` options table.

### MEDIUM letting a partition-less local process join a shared broker

Wrong:

```ts
// laptop dev against the production Redis:
transports.bullmq({ connection: REDIS_URL })
```

Correct:

```ts
transports.bullmq({ connection: REDIS_URL, partition: 'david-dev' })
```

Mechanism: a worker on no partition serves the bare `<name>` tokens — exactly
the queues the deployed fleet consumes — so the local process steals production
tasks; docs call this out under Tenancy pitfalls ("competes for, and steals, the
deployed fleet's tasks"). Source: `docs/concepts/tenancy.mdx`.

### MEDIUM stamping runs into a namespace nothing polls

Wrong:

```ts
await engine.start('checkout', order, id, { namespace: 'eu-west' }) // no engine/operator polls eu-west
```

Correct:

```ts
// Run at least one engine on 'eu-west' (or an operator above it) first:
await engine.start('checkout', order, id, { namespace: 'eu-west' })
```

Mechanism: between namespaced engines there is no fallback owner; a namespace
with neither an engine of its own nor an operator above it is a dead end where
runs sit `pending` forever. Source: `docs/concepts/tenancy.mdx` (pitfalls).

See also: `durable-setup` — the standalone execution model this scales out of.
See also: `durable-transports-stores` — bullmq/queue/db driver details,
namespace mechanics.

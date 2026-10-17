# Cross-ecosystem interop proof

Two directions of the crown-jewel proof that the store-less cluster wire is **byte-compatible across
ecosystems**, both over a real Redis:

- **Forward** (`python-worker.interop.spec.ts`) — an Adonis control-plane dispatches a step a **real
  aviary (`nestjs-durable`) Python worker** executes. See below.
- **Reverse** (`adonis-worker.interop.spec.ts`) — an **aviary (`nestjs-durable`) control-plane**
  dispatches a step a **store-less Adonis `WorkerRuntime`** executes. See
  [§ Reverse direction](#reverse-direction-aviary-control-plane--adonis-worker).

## Forward direction (Adonis control-plane → Python worker)

An Adonis `WorkflowEngine` (control-plane) dispatches a durable `ctx.step('py-echo', …)` onto the aviary
BullMQ/Redis wire, a **real aviary (`nestjs-durable`) Python worker** consumes it off
`${P}-tasks-py-echo`, executes it, and publishes the result on `${P}-results` — which resumes the
Adonis run to `completed` with the value Python computed.

Files:

- `py_echo_worker.py` — an aviary `durable-worker` worker that owns the step `py-echo`.
- `python-worker.interop.spec.ts` — the Adonis-side engine + assertions. **Gated**, so it SKIPS
  cleanly in CI (no Redis / Python / `bullmq` needed).

## Gating env vars

| Var | Required | Meaning |
| --- | --- | --- |
| `DURABLE_INTEROP_REDIS_URL` | yes | Live Redis URL. The whole suite skips without it. |
| `DURABLE_INTEROP_PYTHON` | optional | Path to a Python interpreter with `durable-worker[redis]` installed. When set, the spec **spawns** the worker itself. When unset, it assumes a worker is already consuming `py-echo` on the same prefix and just waits for it. |

## Run it (proven green)

From `packages/adonis`, with **Node 24+** and a live Redis. Requires `bullmq` installed in
`node_modules` (declared in `package.json`; `npm install` / `pnpm install` provides it).

### 1. Ephemeral Redis (Docker)

```bash
PORT=6399
docker run -d -p ${PORT}:6379 --name durable-interop-redis redis:7-alpine
```

### 2. Python worker deps (once)

```bash
cd ../../.. # to the nestjs-durable checkout, or wherever clients/python lives
python3 -m venv clients/python/.venv
clients/python/.venv/bin/pip install -e 'clients/python[redis]'
```

### 3. Run the spec (it spawns the worker)

```bash
cd packages/adonis   # of the adonis-durable checkout
DURABLE_INTEROP_REDIS_URL=redis://localhost:6399 \
DURABLE_INTEROP_PYTHON=/abs/path/to/clients/python/.venv/bin/python \
  node_modules/.bin/vitest run test/interop
```

### 4. Tear down

```bash
docker rm -f durable-interop-redis
```

## What it asserts (live wire evidence)

1. The Python worker's handshake descriptor (`${P}-worker-descriptor:py-echo:*`) is SCANned + JSON
   round-tripped by the **Adonis** transport — `runtime: "python"`, `steps: ["py-echo"]`.
2. The Adonis run reaches `completed` with `{ echoed: { n: 41 }, runtime: "python",
   sdk: "durable-worker", nPlusOne: 42 }` — the value **computed in Python**.
3. The remote checkpoint is routed to the `py-echo` token.
4. Both `bull:${P}-tasks-py-echo:*` (Adonis → Python) and `bull:${P}-results:*` (Python → Adonis)
   keys exist under one shared `bull:` keyspace — the byte-level shared wire.

The `console.log` at the end prints the descriptor, the Python-computed output, and the shared Redis
keys, so a live run documents its own evidence.

## Reverse direction (aviary control-plane → Adonis worker)

The loop-closer: an **aviary (`nestjs-durable`) `WorkflowEngine`** (control-plane) dispatches a durable
`ctx.step('adonis-echo', …)` onto the aviary BullMQ/Redis wire, a **store-less Adonis `WorkerRuntime`**
consumes it off `${P}-tasks-adonis-echo`, executes the body, and publishes the `StepResult` on
`${P}-results` — which resumes the **aviary** run to `completed` with the value **the Adonis worker
computed**. Proves the wire is byte-compatible in BOTH directions.

Files:

- `nestjs_cp.mjs` — the standalone aviary control-plane: it constructs a `WorkflowEngine` +
  `BullMQTransport` DIRECTLY (mirroring nestjs-durable's own `bullmq-transport.db.spec.ts`, not a full
  Nest app) by importing the nestjs-durable checkout's built `dist/` by absolute path, registers a
  workflow dispatching `adonis-echo`, starts a run, and prints `RESULT <json>` on stdout.
- `adonis-worker.interop.spec.ts` — the Adonis-side worker + assertions. **Gated**, so it SKIPS
  cleanly in CI. The Adonis worker ADVERTISES its handshake descriptor so the aviary control-plane's
  dispatch-negotiation guard (handshake design §7.5) sees a live, protocol-compatible worker and
  routes to it instead of parking the run `blocked`.

### Gating env vars

| Var | Required | Meaning |
| --- | --- | --- |
| `DURABLE_INTEROP_REDIS_URL` | yes | Live Redis URL. The suite skips without it. |
| `DURABLE_INTEROP_NESTJS` | yes | Abs path to a **built** nestjs-durable checkout. The suite skips without it. |

### Run it (proven green)

From `packages/adonis`, with **Node 24+** and a live Redis.

#### 1. Ephemeral Redis (Docker)

```bash
docker run -d -p 6398:6379 --name durable-reverse-interop-redis redis:7-alpine
```

#### 2. Build the aviary BullMQ transport (once)

The nestjs-durable `transport-bullmq` package must have a populated `dist/` (the shipped checkout's may
be empty). From the nestjs-durable checkout, with the on-PATH `node_modules/.bin` (the workspace pnpm
shim is unreliable):

```bash
cd packages/transport-bullmq && node_modules/.bin/tsup
```

This only writes gitignored `dist/` — it does not dirty the tracked tree.

#### 3. Run the spec (it spawns the aviary control-plane)

```bash
cd packages/adonis   # of the adonis-durable checkout
DURABLE_INTEROP_REDIS_URL=redis://localhost:6398 \
DURABLE_INTEROP_NESTJS=/abs/path/to/nestjs-durable \
  node_modules/.bin/vitest run test/interop/adonis-worker.interop.spec.ts
```

#### 4. Tear down

```bash
docker rm -f durable-reverse-interop-redis
```

### What it asserts (live wire evidence)

1. The **Adonis** worker's handshake descriptor (`${P}-worker-descriptor:adonis-echo:*`) is live on the
   shared Redis — `runtime: "node"`, `steps: ["adonis-echo"]` — so the aviary control-plane's
   negotiation guard reads a cross-SDK descriptor and routes to it.
2. The **aviary** run reaches `completed` with the object the Adonis worker produced, including a
   per-run random `token` generated INSIDE the worker — so the value can only have travelled over the
   shared wire (a constant assertion can't pass). `runtime: "node"`, `nPlusOne: 42`.
3. Both `bull:${P}-tasks-adonis-echo:*` (aviary → Adonis) and `bull:${P}-results:*` (Adonis → aviary)
   keys exist under one shared `bull:` keyspace — the byte-level shared wire.

The `console.log` at the end prints the descriptor, the Adonis-computed output, the shared Redis keys,
and the control-plane's own log, so a live run documents its own evidence.

# Skill spec — adonis-durable

Autonomous compressed discovery. No maintainer interview was run (fully
autonomous constraint); everything below is grounded in `README.md`,
`docs/**` (every narrative file read), and `packages/*/package.json`.

## Scope decision

The monorepo publishes three packages, but a consumer installs one:
`@adonis-agora/durable@0.25.0`, which ships the whole feature set behind
subpaths (engine + AdonisJS binding, otel, telescope, dashboard,
commands, testing, admission-redis, control-plane-redis). The React SPA
package `@adonis-agora/durable-dashboard@0.2.1` is served BY that provider —
its user-facing surface is the console config/API documented in the main
package's docs. `@adonis-agora/durable-eslint-plugin@0.2.2` enforces workflow
determinism and is deliberately summarized inside the determinism skill rather
than given its own (it has a single rule and a preset; ~30 lines of guidance).

Six skills therefore target `packages/adonis`; one targets `packages/dashboard`
(the observability/operations surface, where the dashboard config and API live).

## Skill inventory (flat; all type `core`; 7 total)

`packages/adonis/skills/`:

1. **durable-setup** — `node ace add/configure`, `defineConfig`, driver-by-name
   `transports`/`stores` maps, engine singleton (`services/main`),
   `Wf.dispatch` vs `.start`, execution model (in-process dispatcher vs
   NOOP_RUN_DISPATCHER + `durable:work`), `consumers`.
2. **durable-workflows** — `BaseWorkflow` classes (auto-registration,
   constructor DI, statics), steps (`@Step`, `defineStep`, string names,
   `transport.handle`), `ctx.localStep`, sleeps/signals/events/signalWithStart/
   eventBatch, webhooks, external tasks, `ctx.transaction`, breakpoints,
   children/`ctx.all`/continue-as-new, singletons, entities, scheduling.
3. **durable-determinism** — the replay rule, `ctx.now`/`ctx.sideEffect`,
   `NonDeterminismError`, versions, `ctx.patched`, eslint-plugin summary.
4. **durable-transports-stores** — five transport drivers, per-step pinning,
   Redis control plane, Lucid store (migration delegation, `autoSchema`,
   repairs, `updateRunIf`), `CodecStateStore`, namespace/partition.
5. **durable-reliability** — retries/backoff/`FatalError`/`retryable:false`,
   `timeoutMs` liveness vs durable suspend, sagas, flow-control queues +
   Redis admission, DLQ, the stuck-run playbook, CLI ops commands, testing
   harness + conformance kits.
6. **durable-cluster** — roles (`standalone`/`control-plane`/`tenant`), thin
   workers (`WorkerRuntime`, `RedisWorkerRegistry`), descriptor handshake,
   capability routing (`requires` → blocked), signed tenant auth, Python /
   NestJS interop over BullMQ.

`packages/dashboard/skills/`:

7. **durable-observability** — dashboard config/authorize/`dashboardAuth`,
   JSON API (retry-with-input, bulk, SSE), lifecycle events, interceptors,
   `collectMetrics`, OTel tracing, Telescope extension.

## Highest-value AI-agent guidance

- **Determinism is the one rule**: no `Date.now()`/`Math.random()`/`new Date()`/
  `crypto.randomUUID()` in a body — use `ctx.now()` / `ctx.sideEffect(...)`;
  the eslint plugin catches it at author time, `NonDeterminismError` at replay.
- **Dev defaults are not production defaults**: in-memory store loses state on
  restart; `memory` transport runs handlers inline — ship `lucid` +
  `eventEmitter`/`queue`/`db`.
- **Lost remote dispatch does NOT self-heal by design** — pick one of
  `timeoutMs`, `remoteRedispatchMs`, or `engine.redispatchPending(runId)`;
  detection windows must exceed the longest legitimate step.
- **Injected services are for composing, not doing work** — call them through
  step refs or their bodies re-run on every replay.
- **Control-flow signals throw** — rethrow via `isWorkflowControlFlowSignal`
  before treating an error as failure.
- **Roles change the command**: store-backed loop = `durable:work`, store-less
  tenant worker = `durable:worker` (which serves step names, not workflow
  bodies unless explicitly registered).
- **The production authorize gate fails closed** when
  `DURABLE_DASHBOARD_TOKEN` is unset — an "empty" dashboard config 403s in prod.

## Remaining gaps (interview substitutes)

- GitHub issue mining was not performed this session; failure-mode priorities
  come from doc emphasis (callouts/warnings) and the operator playbook page.
- Whether `NOOP_RUN_DISPATCHER` splitting is the common deployment shape vs
  standalone is unconfirmed.
- db-vs-queue transport adoption split unknown; both documented first-class.
- dashboardAuth Mode A vs B real-world preference unknown; both covered.

## Composition opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| @adonisjs/queue | queue transport rides its adapters | no — summarized in transports-stores |
| @adonisjs/lucid | lucid store + db transport | no |
| @adonisjs/redis | control plane, admission-redis, bullmq conn | no |
| bullmq / durable-worker (Python) | cross-runtime interop wire | no — covered inside durable-cluster |
| @opentelemetry/api | attachDurableOtel | no — covered inside durable-observability |

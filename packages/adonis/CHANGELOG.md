# @adonis-agora/durable

## 0.21.1

### Patch Changes

- [`940f85b`](https://github.com/DavideCarvalho/adonis-durable/commit/940f85b1ed60717ebde2b1bb3c38abe40504ec8b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Workflow classes can now use constructor dependency injection

  `registerWorkflowClass`/`registerWorkflowsFromDir`/`registerWorkflowsFromBarrel` accept an optional
  **workflow class factory**. The `durable_provider` passes `(Ctor) => app.container.make(Ctor)`, so a
  workflow's constructor is resolved by the AdonisJS IoC container — constructor parameters are
  injected just like `@adonisjs/queue` jobs. Without a factory (library/tests), the class is still
  instantiated with `new Ctor()` as before. The factory may return a promise (the container's `make`
  is async), so the registration functions are now async.

## 0.21.0

### Minor Changes

- [`fd02d95`](https://github.com/DavideCarvalho/adonis-durable/commit/fd02d955599d85c0daa4787e80bbf7fc6ff2c471) - `RedisPubSub` can now actually be satisfied by the two clients it advertises. Its docblock claimed "BOTH a raw `ioredis` instance and an `@adonisjs/redis` connection satisfy it structurally". Against the real typings, **neither did** — passing either one to `RedisControlPlane`/`defineConfig`'s `connection` was a compile error, on an API whose own feature detection is built on the assumption that callers can:

  - A real `Redis` failed on `subscribe`. The port declared `subscribe(channel, handler?)` — that is the `@adonisjs/redis` shape. ioredis's real overloads are `(...channels: (string | Buffer)[], callback?)`, where `callback` is a node-style `(err, result)` _completion_ callback, not a per-message handler; the two are not structurally compatible in either direction.
  - A real `RedisConnection` failed on `on`. The port declared `on?(event: string, listener)`; `@adonisjs/redis`'s is emittery-style `<Name extends keyof ConnectionEvents>(eventName, listener, options?)`, which a plain `string` event does not satisfy.

  It survived because every unit test hands the driver a hand-written fake, and the one spec that used a real client cast the mismatch away at the seam.

  `RedisPubSub` is now a union of the two real shapes — `IoredisPubSub | AdonisRedisPubSub` (both newly exported, along with `IoredisSubscriber`, the narrower surface of the `duplicate()`d subscriber, which cannot publish or re-duplicate). A named type guard maps the existing runtime feature test (`duplicate()` present ⇒ raw ioredis) onto the right arm, so the call sites narrow instead of casting. The three per-event `on` overloads also let the driver drop the `as never` it needed on every listener.

  No runtime behaviour changed: the detection, the channel name, the payload and the watchdog are all untouched, and the suite is unmoved at 984 passing.

  Marked minor rather than patch because `RedisPubSub` stops being an `interface`: a consumer writing `class MyFake implements RedisPubSub` no longer compiles (a class cannot implement a union) and must pick the arm it models. Values assignable to the old shape generally still are — this repo's own fakes needed only that one-word change.

- [`96f2ddf`](https://github.com/DavideCarvalho/adonis-durable/commit/96f2ddf4de29faa7b873bd640196f53c894c01ac) - The generated migration no longer copies the durable schema, and the schema self-heal is no longer silent.

  **Do you need to do anything?** Only if you want the repair recorded in your migration history — nothing is broken today, and nothing breaks on upgrade.

  - **You are on `autoSchema: true` (the default) and your app boots fine.** You may now see one new warning at boot, naming columns like `durable_step_checkpoints.last_heartbeat_at`. That is not a new fault — it is the library finally saying out loud something it has been doing silently at every boot: your database is missing columns the installed version writes, and `ensureSchema()` is adding them for you. Your data is fine and the columns are correct. To make it stop (and to stop depending on a runtime repair for your schema), add one migration:

    ```ts
    import { BaseSchema } from "@adonisjs/lucid/schema";
    import db from "@adonisjs/lucid/services/db";
    import { createDurableTables } from "@adonis-agora/durable";

    export default class extends BaseSchema {
      static disableTransactions = true;
      async up() {
        await createDurableTables(db, this.db.connectionName);
      }
      async down() {} // convergence only — it did not create these tables
    }
    ```

    It is idempotent, additive-only, and a no-op where the self-heal already ran. `static disableTransactions = true` is required: the DDL runs on a connection the `Database` manager checks out itself, so on a `pool: { max: 1 }` connection the migrator's transaction would hold the only connection and the migration would hang.

  - **You see no warning.** Nothing to do. Your migrations are current — the warning fires only on an applied repair, never on a schema that is already right, and never on a fresh database.

  - **You are on `autoSchema: false`.** You are the case that could actually be broken, because nothing repairs your schema at boot. If your `durable_step_checkpoints` lacks `last_heartbeat_at` / `heartbeat_progress`, step heartbeats have been silently discarded (the engine's heartbeat write is fire-and-forget, so it never surfaced). Run the migration above.

  **Why the change.** The migration stub reproduced the DDL that `createDurableTables` already produces, and the copy drifted twice — most recently missing `last_heartbeat_at` and `heartbeat_progress`, which `LucidStateStore.recordStepHeartbeat` writes on every beat. Fixing the stub did not help anyone who had already run `node ace configure`: their migration file is a frozen copy of the old DDL, and their app only worked because `ensureSchema()` patched the database at every boot with nothing recorded anywhere. A consumer audit found an app in exactly that state, byte-identical to the published stub, for eleven minor versions.

  So the schema now lives in one place. `node ace configure @adonis-agora/durable` generates a migration that calls `createDurableTables(db, this.db.connectionName)` (with `db` from `@adonisjs/lucid/services/db`) and `dropDurableTables` in `down()`, instead of a DDL snapshot that can go stale. The trade, taken deliberately: a migration that calls the library is not a frozen snapshot, so a fresh database follows the installed version rather than the version you generated under. That is what already happened at boot via `autoSchema`, `createDurableTables` only ever adds tables and nullable/defaulted columns, and the schema belongs to the library — hand-versioning it is what drifted in the first place.

  `createDurableTables(db, connectionName?, options?)` takes an optional third argument, `{ logger }`, to route the applied-repair warning into your own logger instead of `console`. Existing two-argument calls are unaffected. No exports moved and no signature broke; the DDL itself is unchanged.

  Not changed on purpose: `autoSchema`'s default (the repair stays on, and apps in production depend on it), the repair itself (it warns, it does not throw), and the engine's fire-and-forget heartbeat write (a lost liveness update genuinely never harms a run).

- [`e3a1a5e`](https://github.com/DavideCarvalho/adonis-durable/commit/e3a1a5ec5bc7c6f49a8f36982aab89d61695fefd) - Fix: an operator's `cancel` (or a timeout sweep, or crash-recovery's dead-letter) landing WHILE a run's in-flight turn was still executing used to be silently undone. `settleRun`'s `completed`/`failed` branches wrote the run's terminal status with an unconditional blind patch — no status predicate at all — so a turn that started from a snapshot taken before the cancel would finish and overwrite `cancelled` back to `completed`, and the waiting parent workflow would be told the child succeeded. The `suspended` branch had a narrower guard (re-reading the run and checking only for `cancelled`), but that read-then-write was itself a TOCTOU race across the same `await`.

  All three branches — plus `sweepTimeouts` (an unconditional `cancelled` write in a loop with awaits between iterations) and `parkBlocked` (a read-then-write guard that checked only `cancelled`/`completed`, missing `failed`/`dead`) — now go through a new atomic compare-and-set: the write applies only if the run's currently persisted status is still one it's legitimate to transition from, and the predicate is evaluated in the same statement as the write (the database, not a prior JS read, arbitrates), so two racing writers can never both apply.

  **`StateStore` implementers must add `updateRunIf(runId, expectedStatuses, patch): Promise<boolean>`** — a new required method on the contract, alongside the existing `updateRun`. It applies `patch` only if the run's current status is one of `expectedStatuses`, returning whether the write applied (never throwing on a non-match). For a SQL-backed store the predicate must be part of the `UPDATE ... WHERE` clause; a read-then-write in application code does not provide the same guarantee and reintroduces the exact race this fixes. `@adonis-agora/durable`'s own `LucidStateStore` and `InMemoryStateStore` (and the `CodecStateStore` payload-encryption decorator) already implement it; a custom `StateStore` adapter needs the same addition to keep conforming to the shared `runStateStoreContract` test kit.

### Patch Changes

- [`878a628`](https://github.com/DavideCarvalho/adonis-durable/commit/878a628b3bd83b9f2e69f57e23e0af4a8d402988) - Build: `pnpm build` can no longer exit 0 having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`, so removing `dist/` and leaving the buildinfo behind (a plain `rm -rf dist`, then a build) made the compiler conclude every output was current and emit nothing. The `copy:stubs` half is a plain `cp`, so it still ran: the result was a `dist/` holding `assets/` and `stubs/` and zero `.js` files, from a build that reported success. Turbo then wrote that empty directory into its cache as a successful `build` and replayed it — `>>> FULL TURBO` — on every later run, including from an otherwise clean tree, so one such build poisoned the cache for good.

  The build now removes `dist/` before compiling and compiles through a `tsconfig.build.json` with `incremental: false`, so it keeps no state that can disagree with `dist/`, and a new post-condition fails the build outright if `dist/` ends up without JavaScript or without the package entrypoint. That check runs inside the `build` script rather than in CI, which is what makes it cover `prepack` — the path a manual `pnpm publish` takes, and the one place turbo was never involved. `build` and `typecheck` also stop sharing a single buildinfo file, so the two turbo tasks can no longer race on it or restore each other's incremental state from cache.

  No published version is known to be affected. CI builds from a cold checkout, so the trigger (removing `dist/` from a tree that already had a buildinfo) does not arise there, and `@adonis-agora/durable`'s spec that imports the built `dist/src/index.js` hard-fails under CI when the build is missing — both release workflows run the suite before publishing. The exposure was a developer machine and any cache shared from one. There is nothing to re-install or re-publish because of this.

- [`809cd9e`](https://github.com/DavideCarvalho/adonis-durable/commit/809cd9ef732dbb9fd30c62dca79bae54e8458945) - Fix(bullmq): on the BullMQ transport, steps with a `timeoutMs` no longer false-timeout and get re-dispatched while still running. `#runTask` never passed the heartbeat callback to `runStepHandler`, even though `heartbeat()` and `onHeartbeat` were fully wired — so a healthy, actively-progressing long step emitted no beats, `engine.awaitWithHeartbeat` never rearmed its liveness window, and at `timeoutMs` the engine concluded the worker was dead and re-dispatched the same `stepId` while the original worker was still executing it. The transport now emits step heartbeats the engine's liveness window depends on, matching the `db` and `queue` transports.

- [`6bbcf6a`](https://github.com/DavideCarvalho/adonis-durable/commit/6bbcf6ac9eea3bbd3b070b6784edc9f5139c83e7) - `discoverWorkflows` now hands back a constructor you can actually call. `DiscoveredWorkflow.cls` was typed as `WorkflowClass`, which is deliberately `abstract new (...) => ...` — that shape exists so any `BaseWorkflow` subclass can be _referenced_ (`ctx.child(Cls)`, `engine.start(Cls)`), and an abstract constructor type is by definition not newable. So `new (await discoverWorkflows(dir))[0]!.cls()` failed to compile with `TS2511: Cannot create an instance of an abstract class`, even though the value is a real, instantiable class and `registerWorkflowClass` does exactly that `new Ctor()` internally, through a local cast that quietly asserted the concrete shape the public type withheld.

  `cls` is now a new exported `DiscoveredWorkflowClass` — the concrete `new () => { run(ctx, input) }` shape the module already relied on. Concrete constructor types stay assignable to `WorkflowClass`, so every reference-style use of a discovered class keeps compiling; the change only removes an error. Type-level only: no runtime behaviour changed, and the same `registerWorkflowClass` cast is now expressed in terms of the exported type instead of an inline duplicate.

- [`6be2a47`](https://github.com/DavideCarvalho/adonis-durable/commit/6be2a4791f9591a8db28e4744aa867b6cf998e12) - Fix: directory discovery of `app/workflows` and `app/steps` now finds `.ts` modules in a dev app instead of silently registering nothing. Both scanners derived the extension to import from this library's own compiled file (`import.meta.url`) rather than from the directory being scanned — resolved as `.js` from `node_modules` in a consuming app, so every `.ts` entry in `app/workflows` / `app/steps` was skipped with no warning. The extension is now derived from the scanned directory's own entries, preferring `.ts` when both a built `.js` and its `.ts` source are present (so a module is never registered twice).

- [`1359fea`](https://github.com/DavideCarvalho/adonis-durable/commit/1359fea60ecd1ce0df332006f5a1757c83c04e93) - Fix: `node ace add @adonis-agora/durable` now actually configures the package. The `configure` hook was only reachable through the `./configure` subpath, which AdonisJS never reads — it imports the package main and looks for `configure` there, so the command silently warned and did nothing (`Cannot configure module ... does not export the configure hook`). The package main now re-exports `configure`, so `node ace add` registers the provider, publishes `config/durable.ts` + `config/durable_dashboard.ts`, and publishes the migration stubs as documented.

- [`3e202d3`](https://github.com/DavideCarvalho/adonis-durable/commit/3e202d3e4c033ea1e708ed7c46c6b75794575a05) - Fix: the published migration stub (`node ace configure @adonis-agora/durable` → `migration:run`) now creates `last_heartbeat_at` and `heartbeat_progress` on `durable_step_checkpoints`. Those columns were only ever created by the `autoSchema: true` auto-schema path, never by the migration — so an app provisioned via `migration:run` (the documented path, and the only one when `autoSchema: false`) silently lost step-level heartbeat persistence: `LucidStateStore.recordStepHeartbeat` writes both columns on every beat, the engine swallows the resulting UPDATE error, and no heartbeat data ever showed up in the dashboard or in `durable:runs --stale`.

  Upgrade note for existing installs: apps on `autoSchema: true` (the default) pick up the two columns automatically on next boot — `createDurableTables` carries an in-place auto-migration for them. Apps on `autoSchema: false` need a follow-up migration adding `last_heartbeat_at` (bigInteger, nullable) and `heartbeat_progress` (text, nullable) to `durable_step_checkpoints`.

## 0.20.0

### Minor Changes

- [#43](https://github.com/DavideCarvalho/adonis-durable/pull/43) [`b4ba291`](https://github.com/DavideCarvalho/adonis-durable/commit/b4ba2916c3e8cdb198e86c60b7aac403df4df3d2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `@Scheduled(...)` class decorator — the decorator form of the colocated `static schedule`. It only stamps `static schedule` on the class; normalization (key defaults, `workflow` fill-in, the `static workflow` requirement) stays in `workflowSchedules`, so both authoring forms behave identically:

  ```ts
  @Scheduled({ cron: '0 4 * * *', timezone: 'America/Sao_Paulo' })
  export default class CrawlWorkflow extends BaseWorkflow {
    static workflow = { name: 'crawl' }
    async run(ctx: WorkflowCtx) { … }
  }
  ```

  Repeated applications and an existing `static schedule` literal compose, accumulating in source order (top decorator first, then the literal). With several schedules on one class, prefer explicit `key`s over the positional `${name}:${i}` defaults — the key is part of the deterministic run id, and reordering declarations would silently re-key them.

## 0.19.2

### Patch Changes

- [#41](https://github.com/DavideCarvalho/adonis-durable/pull/41) [`b0c3e63`](https://github.com/DavideCarvalho/adonis-durable/commit/b0c3e63297973ac93b514a624c7ecb73c3093657) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The dashboard's `authorize` hook can now own its denial response. A hook that writes a redirect before returning `false` — e.g. `ctx.response.redirect('/login')`, the natural UX when the dashboard is guarded by the host app's own session (Authkit/session + role check) instead of a bearer token — used to have its 302 overwritten by the provider's uniform `403 {"error":"forbidden"}`. The provider now respects a response the hook already wrote (detected via the `Location` header) and only falls back to the 403 when the hook left the response untouched.

## 0.19.1

### Patch Changes

- [#39](https://github.com/DavideCarvalho/adonis-durable/pull/39) [`af88875`](https://github.com/DavideCarvalho/adonis-durable/commit/af888753ebf58f6acbc01ef67b764bb0fed5bc03) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A result arriving after its run went terminal no longer resurrects the run.

  `completeRemoteResult` guarded only `cancelled`/`completed`: a late result for a **failed**/**dead** run settled the checkpoint and resumed it — observed in production as a `failed` run flipping to `suspended` and carrying on as if the failure never happened, racing whatever the operator had done about it (and, had the workflow used sagas, running AFTER compensations already unwound). Terminal is terminal: recovery of a failed run belongs to an explicit `requeue`/`durable:retry`, never to a stray result.

  Semantics now: for a failed/dead run, a late **success** still settles the checkpoint (salvage — an explicit retry's replay short-circuits the finished step instead of re-running minutes of real work) but never resumes; a late **failure** is dropped outright; the redelivered-result re-drive path (settled checkpoint → resume) also refuses terminal runs. Cancelled/completed behavior is unchanged.

## 0.19.0

### Minor Changes

- [#37](https://github.com/DavideCarvalho/adonis-durable/pull/37) [`9cff848`](https://github.com/DavideCarvalho/adonis-durable/commit/9cff84804bd3b8b3f63a3b7fd4b841b6346deb47) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Liveness follow-ups — both halves paid for in production:

  **`pickupTimeoutMs` + automatic pickup beat: queue wait is not silence.** The `timeoutMs` window is anchored at dispatch, but the stretch a job spends QUEUED produces no heartbeats by definition — a single-concurrency worker whose batches run ~15min made the next batch wait silently the whole time, and a dispatch-anchored window false-failed a healthy fleet. Now every worker emits an automatic pickup beat the moment it claims a task (via `runStepHandler` — this also stamps `lastHeartbeatAt` for handlers that never beat manually, so "queued" vs "executing" is visible on every remote checkpoint), and the new `pickupTimeoutMs` step option (def-level or per-call; defaults to `timeoutMs` — the historical behavior) governs the pre-first-beat stretch, handing over to the tighter `timeoutMs` once execution starts: `pickupTimeoutMs` = "how long may it stay queued", `timeoutMs` = "max silence while running". The heartbeat persist throttle lets a progress-carrying beat punch through when the last persisted beat had no payload, so the pickup beat never shadows the handler's first real progress.

  **Singleton release no longer orphans gated runs under a no-op run dispatcher.** `wakeNext` used to CLEAR the gated run's retry `wakeAt` before handing it to the run dispatcher — but the dispatcher may legitimately be a no-op (poll-only deployments where `durable:work` owns every pickup), which left the run `suspended` with no wake time, unreachable by every poll path, forever. It now stamps a due-now `wakeAt` instead: a real dispatcher still runs it immediately, and the timer poller is the guaranteed fallback (the run lease makes a double-drive a cheap no-op).

## 0.18.0

### Minor Changes

- [#35](https://github.com/DavideCarvalho/adonis-durable/pull/35) [`7668030`](https://github.com/DavideCarvalho/adonis-durable/commit/7668030d377bd879237c97efd98e4d553a995658) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Step-level liveness, end to end: `log.heartbeat(progress?)` for long step handlers.

  A long remote step (a 15-minute browser batch) was indistinguishable from a hung one: logs and sub-events only ship WITH the result, the heartbeat lane existed in every transport but nothing could emit into it, and the in-memory `timeoutMs` path persisted no checkpoint at all mid-flight — so status surfaces had to infer liveness from domain tables.

  Now the step handler's `StepLogger` carries `heartbeat(progress?)`: it travels immediately over the transport's heartbeat lane (throttled, ≥5s between emissions), rearms the step's `timeoutMs` window on the engine (a beating step never falsely times out — so `timeoutMs` can be tightened to "max tolerated silence" instead of "max total duration"), and the engine persists the latest beat on the step's checkpoint (throttled ≥10s, best-effort) as `StepCheckpoint.lastHeartbeatAt` / `heartbeatProgress` — visible cross-process via `listCheckpoints`, and in `durable:runs` (the PENDING column shows `hb <age>`; `--stale` no longer flags a step whose worker beat within the threshold).

  The in-memory `timeoutMs` path now also persists its `pending` checkpoint at dispatch (per attempt): the step becomes visible outside its process, beats have somewhere to land, and a result consumed by a different engine instance completes the checkpoint instead of being dropped. Replay semantics are unchanged (`timeoutMs` steps route to the in-memory path regardless of an existing pending row; `completed` still short-circuits).

  New optional store capability: `StateStore.recordStepHeartbeat(runId, seq, at, progress?)` (implemented by the Lucid and in-memory stores; the checkpoints table gains nullable `last_heartbeat_at`/`heartbeat_progress`, auto-migrated in place by `ensureSchema`).

## 0.17.1

### Patch Changes

- [#33](https://github.com/DavideCarvalho/adonis-durable/pull/33) [`43ba321`](https://github.com/DavideCarvalho/adonis-durable/commit/43ba3211b17780e05eabf5f446a413d646bce43f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `runSchedules` now fires and reports only genuinely NEW windows. It used to call the (idempotent) `engine.start` for every due window's bucket id on every tick and count the no-op — so `durable:work` logged "N scheduled" every second for the rest of each window, reading like a run-per-tick flood when nothing was being started. The pre-check costs no extra I/O (`start` did the same `getRun` internally before its no-op return); a same-boundary race between instances can still briefly overcount the report, never the runs.

## 0.17.0

### Minor Changes

- [#31](https://github.com/DavideCarvalho/adonis-durable/pull/31) [`50701b4`](https://github.com/DavideCarvalho/adonis-durable/commit/50701b4ae06f08c4c75786aec69332a411bd190c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console/REPL processes no longer become accidental queue workers.

  Every booted app process used to subscribe the transport's consumer loops (step tasks, results, heartbeats, control): the engine's constructor binds results/heartbeats and the provider serves `app/steps` at boot. On a point-to-point broker transport that made ANY `node ace` process compete with the real worker fleet — a one-off command claimed step jobs it died with (observed in production as jobs wedged in `active` stamped with the worker ids of long-gone commands), stole results addressed to the long-lived engine, and a boot-time command with jobs queued never exited (the burst-drain loop kept feeding it, blocking a container's `exec durable:work` handoff forever).

  Now, with the new config default `consumers: 'auto'`, a `console`/`repl` process **defers** consumption: it can still dispatch runs, publish and read the store — a pure producer — while jobs stay queued for a real worker. `durable:work` declares itself a worker via the new `engine.startConsumers()` before its first tick, so the worker command behaves identically. Web and test processes keep today's eager behavior, and `consumers: 'always'` restores it everywhere (for a console script that must round-trip remote steps inline).

  New surface: optional `Transport.deferConsumers()` / `Transport.startConsumers()` (implemented by `QueueTransport`; in-process transports need no gating), `TransportPool.startConsumers()`, `WorkflowEngine.startConsumers()`, and `consumers?: 'auto' | 'always'` on the config.

## 0.16.1

### Patch Changes

- [#23](https://github.com/DavideCarvalho/adonis-durable/pull/23) [`6e4a3f1`](https://github.com/DavideCarvalho/adonis-durable/commit/6e4a3f12417e7ba30b970f7078e6baf972948549) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Corrige problemas de robustez no engine e no bootstrap:

  - **Efeitos pós-settle agora são aguardados pelo `drain()`.** Depois que um run era persistido no
    estado terminal, `settleRun` disparava `notifyParent` (que pode acordar e retomar um run PAI
    suspenso) e o `execute`/`cancel` disparavam o `wakeNext` do singleton — ambos fire-and-forget, fora
    do conjunto `inflight`. O `drain()` só esperava o `inflight`, então essas escritas no store
    escapavam da drenagem: em apps que rodam testes sob uma transação global do Lucid, o `updateRun` do
    pai/singleton disparava após o rollback, virando um unhandled rejection ("Transaction query already
    complete") depois da suíte passar — CI vermelho com testes verdes. Esses efeitos agora entram num
    registry `postSettle` que o `drain()` aguarda junto com o `inflight` (em laço, pois um efeito pode
    retomar outro run), sem que o caminho do `execute()` passe a bloquear neles — o retorno ao chamador
    continua imediato ao persistir o status.

  - **Mais três efeitos fire-and-forget internos passam a ser aguardados pelo `drain()`.** Eram da mesma
    classe do `notifyParent`/`wakeNext` — `queueMicrotask(...)` sem tracking, com escrita no store,
    disparados de dentro de um run que settla/cancela — e pré-existiam desde antes deste PR, expondo
    consumidores de cancelamento de child, entidades duráveis e compensação saga ao mesmo
    "Transaction query already complete" pós-teardown que este PR combate:

    - **`ctx.cancelChild`** (usado pelo `ctx.all` failFast p/ cancelar os irmãos sobreviventes): o
      `cancel()` — que escreve o filho e toda a cascata de cancelamento no store — agora entra no
      `postSettle` (defer de reentrância preservado, promise registrada de forma síncrona).
    - **`ctx.signalEntity`** (entidades duráveis): o `entities.dispatch` persiste via `signalWithStart`
      (createRun/signal do run da entidade), então a op passa a ser aguardada pelo `drain()`.
    - **Resume da compensação no cancel-compensate** (`engine.cancel({ compensate: true })`): o resume em
      background que replaya o run e roda as compensações até o `cancelled` terminal era um
      `queueMicrotask` não-rastreado, e o `resume()` só entra no `inflight` quando de fato é chamado (um
      microtask depois) — então o `drain()` podia ver os dois registries vazios nessa janela pré-`inflight`
      e retornar antes das escritas de compensação. Agora o resume deferido é segurado no `postSettle`
      (não é um `handoffRun`: aqui um run EXISTENTE é retomado, e sua execução já se auto-rastreia no
      `inflight` — só a janela antes da chamada precisava ser coberta).

  - **Os handoffs internos de run (`continue-as-new` e child deferido) também são aguardados pelo
    `drain()`.** Antes, ambos entravam por um `queueMicrotask(() => void this.start(...))` fire-and-forget:
    entre o settle do pai e o novo run entrar no `inflight` havia hops de microtask + I/O de store, e essa
    ponte ficava fora dos dois registries. O `drain()` podia observar `inflight` e `postSettle` vazios
    nessa janela e retornar cedo, deixando a persistência (`createRun`) e o processamento do run
    continuado/filho escaparem — o mesmo hazard "Transaction query already complete" pós-rollback, agora
    para quem usa continue-as-new/child workflows. Agora cada handoff é registrado no `postSettle` de
    forma síncrona no settle do pai (via `handoffRun`), preservando o defer de reentrância; com o
    dispatcher in-process padrão ele mesmo conduz o pickup (`leaseAndResume`, sem o guard de `draining`,
    pois é trabalho já em voo que o `drain()` aguarda), então a promise só resolve quando o run entrou no
    `inflight` e settlou. O run fica brevemente nos DOIS conjuntos, o que é inofensivo porque o laço do
    `drain()` re-snapshota ambos a cada iteração.

  - **`whenBootedApp()` agora falha com mensagem clara em vez de pendurar pra sempre.** O top-level
    `const app = await whenBootedApp()` do `services/main` ficava pendente SILENCIOSAMENTE se o
    `DurableProvider` não estivesse registrado nos providers — DX pior que um erro explícito. Agora um
    timeout (padrão 5s) rejeita com uma mensagem acionável apontando pra adicionar
    `"@adonis-agora/durable/durable_provider"` no `adonisrc.ts`. O caminho normal não é afetado: o
    provider registra antes do await, então o fast path devolve uma promise já resolvida (sem timer
    armado); mesmo quando um timer é armado ele é limpo — e `unref`'d — assim que o app chega.

  - **`services/main` não captura mais o singleton `app` do core de forma eager.** O
    `import app from '@adonisjs/core/services/app'` no topo do módulo é o mesmo dual-package hazard que
    já quebrou produção com o `@adonisjs/lucid`: com duas cópias físicas de `@adonisjs/core` na árvore
    (pnpm/hoist), a cópia importada pode não ser a que o `bin/server` bootou, deixando o `app` como
    `undefined`. Agora o `DurableProvider` alimenta a instância booted que RECEBE no `register()` para
    um módulo `services/booted_app`, e o `services/main` lê dali — imune ao split de cópias. O
    comportamento observável para os consumidores atuais (`import engine`, `import { runGateway }`) é
    idêntico.

## 0.16.0

### Minor Changes

- [#28](https://github.com/DavideCarvalho/adonis-durable/pull/28) [`024b7b5`](https://github.com/DavideCarvalho/adonis-durable/commit/024b7b54929284f2e88b782d108d2051af3d9d44) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `static workflow` now accepts `singleton` (a `SingletonConfig`), and `app/workflows` discovery carries it through to `engine.register`. Before this, per-key run serialization was reachable only via a manual `engine.register(name, version, fn, { singleton })` — which forced anyone who needed a mutexed _scheduled_ workflow to bypass the discovery convention entirely, because a colocated `static schedule` fires a new run per window whether or not the previous one is still active. Declaring `singleton: { key: () => '...' }` next to the schedule now serializes those windows natively: excess runs gate (suspended) and admit in creation order when the slot frees.

- [#24](https://github.com/DavideCarvalho/adonis-durable/pull/24) [`390a7c1`](https://github.com/DavideCarvalho/adonis-durable/commit/390a7c120e32f9f859f8b31936eb0a7b8471a63d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `defineConfig` now carries `remoteRedispatchMs` / `remoteRedispatchMax` through to the engine. The engine has always implemented this store-driven net for a remote step whose dispatched job was LOST (worker crashed after claiming it, or the transport dropped the job) — but the AdonisJS provider built the engine from an explicit allowlist that omitted both keys, so the net could not be turned on from `config/durable.ts` at all, leaving `engine.redispatchPending(runId)` as the only (manual) recovery.

  Off by default, unchanged semantics: when set, a reconcile pass that finds a remote step still `pending` past the window re-dispatches it, bounded by `remoteRedispatchMax` (default 10). The window must exceed the longest legitimate run of the step, and steps must be idempotent — re-dispatch can double-run a step whose original job is merely slow.

- [#25](https://github.com/DavideCarvalho/adonis-durable/pull/25) [`a0dae13`](https://github.com/DavideCarvalho/adonis-durable/commit/a0dae13be123aebbd29b6cdafcf827b3191e410e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The `queue` transport now reclaims stalled jobs. It drives the `@adonisjs/queue` adapter directly (`pushOn`/`popFrom`/`completeJob`) instead of the broker's `Worker` class — but `recoverStalledJobs` was only ever called from that same `Worker` class, so a worker that died after claiming a job left it in the broker's `active` state forever, with no re-delivery and no error (observed in production: jobs orphaned across container restarts, their steps `pending` indefinitely).

  A coarse background sweep (default every 30s) now calls `adapter.recoverStalledJobs` for every queue this instance pops from — per-handler task queues on the worker side, and the results/heartbeats/control queues on the engine side (a dead engine orphans claimed result jobs the same way). New `QueueTransportOptions`: `stalledCheckIntervalMs` (default 30s; `0` disables), `stalledThresholdMs` (default 30min — the claim's `acquiredAt` is never renewed while a worker processes, so the threshold must exceed your longest legitimate step; re-delivery double-runs a merely-slow worker's step, which the durable idempotency contract makes safe but not free), `maxStalledCount` (default 3 — bounds a poison job). Adapters without `recoverStalledJobs` are detected and skipped.

- [#26](https://github.com/DavideCarvalho/adonis-durable/pull/26) [`fc1f9b7`](https://github.com/DavideCarvalho/adonis-durable/commit/fc1f9b7ff33ad0cc4abc4a611401de7545487ec6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `durable:runs` now surfaces liveness signals so a `suspended` run's listing stops looking identical whether it's mid-step or stranded. `suspended` is the run's normal resting state while a remote step is in flight — it's also the only symptom a lost dispatch (worker died after claiming the job) ever produces, and nothing auto-redrives it (see `redispatchPending`'s own doc).

  Each row now shows RECOVERY (`recovery_attempts`, blank unless > 0) and PENDING (the age + attempt count of the oldest `pending` REMOTE checkpoint, for `running`/`suspended` runs) alongside the existing columns; UPDATED now renders as a compact duration (`4h32m`) instead of `"4h ago"`.

  A new `--stale[=<duration>]` flag (default threshold 15m, e.g. `--stale=1h`) narrows the listing to runs whose pending remote step exceeds that age — the "these are probably stranded" view — and prints a hint pointing at the two recovery paths that actually exist: `engine.redispatchPending(runId)` and `node ace durable:retry <runId>`.

  The dashboard's `GET /runs` list payload also gains `recoveryAttempts` per run (free — already on the row); the oldest-pending-checkpoint age was deliberately left off that endpoint to avoid an N+1 `listCheckpoints` per row — `GET /runs/:id` already returns the full checkpoint timeline for that.

  New exports from `@adonis-agora/durable/*` command surface: `attachLiveness`, `filterStale`, `parseDurationMs`, `staleHint`, `DEFAULT_STALE_MS`, `RunLiveness`, `StalePendingStep`. `RunLister` now also requires `listCheckpoints` (both `WorkflowEngine` and every `StateStore` already implement it) and `renderRunsTable` now takes `RunLiveness[]` instead of `WorkflowRun[]`.

## 0.15.2

### Patch Changes

- [#21](https://github.com/DavideCarvalho/adonis-durable/pull/21) [`68386e7`](https://github.com/DavideCarvalho/adonis-durable/commit/68386e722742fe95f6d852e442dd62760a8eb8e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make `bullmq` an optional peer dependency instead of a hard dependency.

  0.15 added `bullmq` as a hard `dependency`. Because `bullmq` pins an EXACT `ioredis`
  (e.g. `ioredis@5.11.1`), every app installing durable got a SECOND ioredis copy in its tree —
  including apps that only use `transports.queue()`/`db`/`eventEmitter` and never touch the bullmq
  transport. With two ioredis copies present, `@boringnode/queue`'s `redis()` adapter factory checks
  `connection instanceof Redis` against its own ioredis copy; the live connection `@adonisjs/redis`
  handed it was built by the OTHER copy, so the check is false, the factory falls through to
  `new Redis({ host: 'localhost', port: 6379 })`, and the app hangs at boot in an
  `ECONNREFUSED 127.0.0.1:6379` retry loop instead of reusing the configured Redis.

  `bullmq` is now an optional peer dependency, loaded lazily (via a non-literal specifier) only inside
  `createBullMQDeps`, the code path behind `transports.bullmq()`. Apps that do not select the bullmq
  transport no longer install bullmq, no longer gain the duplicate ioredis, and no longer hit the
  `instanceof` mismatch. Apps that DO use `transports.bullmq()` should add `bullmq` to their own
  dependencies (the optional peer makes this explicit).

## 0.15.1

### Patch Changes

- [#19](https://github.com/DavideCarvalho/adonis-durable/pull/19) [`cc45f89`](https://github.com/DavideCarvalho/adonis-durable/commit/cc45f8988171db16a93700839a8745dffdb0d577) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `transports.bullmq()`/`createBullMQDeps()` silently minting a Redis client bound to ioredis's own default (`127.0.0.1:6379`) instead of the caller's Redis when `connection` is falsy or an empty object — it now throws a clear, actionable error at boot instead of a silent misconnect that only surfaces as an `ECONNREFUSED 6379` retry loop once the real Redis is unreachable on the default host/port.

## 0.15.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/adonis-durable/pull/17) [`f0a79a3`](https://github.com/DavideCarvalho/adonis-durable/commit/f0a79a3231099d176d3220edbe60f2bb2b0a803a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add colocated `static schedule` on workflow classes. A `BaseWorkflow` subclass can now declare its recurring schedule(s) inline — `static schedule = { cron, timezone, paused, … }` (a single object or an array) — instead of only listing them in `config/durable.ts` → `schedules`. Colocated schedules are discovered by `app/workflows` auto-discovery and merged with the config schedules; the `durable:work` worker tick fires both identically. The default `key` is derived deterministically from the workflow name (`${name}:${i}` for an array), keeping the schedule's time-bucket run id stable. On a `key` collision, an explicit `config.schedules` entry wins. Also exports the `WorkflowScheduleConfig` type and the `workflowSchedules(cls)` reader.

## 0.14.0

### Minor Changes

- Convention dispatch is now **unconditional** — there is no `remoteByConvention` config/engine option anymore (it was added in 0.13.0 and is removed here). Nothing is registered by default; a run started for a workflow name this engine has no local registration for is routed to a live worker group of the same name, exactly as the aviary engine has always done. The queue name **is** the routing.

  If no live worker group matches the name, `start`/`resume` still throws `is not registered` (unchanged fail-fast). Runtime behaviour is identical to 0.13.0's default; only the now-pointless opt-out knob is gone. `registerRemote(...)` remains for pinning a specific group/version.

## 0.13.0

### Minor Changes

- Convention dispatch is now **on by default** — a run started for a workflow this engine has no local registration for is routed to a live worker group of the same name, with **no `registerRemote` boilerplate**. This matches the aviary engine (which has always routed by convention) and is what makes a Python/NestJS/thin-worker workflow reachable by name: just `engine.start('pipeline', input)` (or `ctx.child('pipeline', …)`) and a live `pipeline` worker group picks it up.

  Opt out with `remoteByConvention: false` in `config/durable.ts` to restore the fail-fast "workflow is not registered" throw for unknown names. `registerRemote(...)` still exists for pinning a specific group/version, but is no longer required.

## 0.12.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/adonis-durable/pull/15) [`ae3fbee`](https://github.com/DavideCarvalho/adonis-durable/commit/ae3fbee7e00a32ff9d2463d616aeea8a1a5ac566) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O provider agora **provisiona o schema do store no boot** por padrão — o durable passa a gerenciar as próprias tabelas, como o resto do ecossistema (agent/authz/telescope), em vez de exigir uma migration.

  Novo `autoSchema?: boolean` no config (default `true`): quando ligado, `DurableProvider` chama `store.ensureSchema()` ao resolver o store (idempotente, `CREATE TABLE IF NOT EXISTS`; o store lucid resolve o db pelo alias `'lucid.db'`, disponível no boot). O store in-memory não tem schema, então é no-op.

  ```ts
  // dev/prod: sem migration, a lib cria as tabelas
  export default defineConfig({ store: 'lucid', stores: { lucid: stores.lucid({ connection: 'main' }) } })

  // opt-out: gerencie via migration com createDurableTables(db, connection)
  export default defineConfig({ autoSchema: false, store: 'lucid', stores: { lucid: stores.lucid(...) } })
  ```

  **Mudança de comportamento:** apps existentes que criavam as tabelas via migration passam a também provisioná-las no boot (idempotente — as tabelas já existentes são um no-op). Para manter o comportamento anterior (só migration, sem DDL no boot), setar `autoSchema: false`.

## 0.11.0

### Minor Changes

- Store-less cluster + cross-ecosystem interop: separate API from engine and run store-less "thin" pods that only talk to the control plane. New role-discriminated config (`standalone` / `control-plane` / `tenant`, `store?: never` on tenant → compile-time isolation), an aviary byte-compatible BullMQ transport (a Python aviary worker can share the same control plane, proven live both directions), the P4 RunGateway (Store/Proxy/Responder) request/reply protocol with layered tenant auth, a store-less WorkerRuntime running steps + workflow turns + parallel `gather` (subpath `@adonis-agora/durable/worker`, no Lucid), a worker-descriptor handshake with capability/protocol negotiation + capability-aware dispatch (park `blocked` instead of hanging), and a dashboard fleet-health panel. Adds `bullmq` as a dependency.

## 0.10.0

### Minor Changes

- Parity sync from nestjs-durable: retry now re-executes failed runs (was a no-op), self-heal event-waiting suspends orphaned by a lost wake (`reconcileMs`), recover a remote step whose dispatched job was lost (`redispatchPending` + `remoteRedispatchMs`), cascade retry + retry-adoption, and `ctx.all` failFast cancels surviving siblings + `webhook().wait({ timeoutMs })`.

## 0.9.1

### Patch Changes

- [#13](https://github.com/DavideCarvalho/adonis-durable/pull/13) [`b43fdc8`](https://github.com/DavideCarvalho/adonis-durable/commit/b43fdc8a5824bfc71920d8ccb55f0a765614bc0a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the Lucid store & db transport breaking `durable: true` through the app's normal boot, and honor a dedicated connection

  Two boot-time bugs in the Lucid state store and db transport, both only reachable
  through the real provider boot path (no prior test exercised it):

  - **`stores.lucid()` / `transports.db()` resolved the Lucid `Database` from
    `@adonisjs/lucid/services/db`'s default export.** The provider builds these
    thunks while resolving the `WorkflowEngine` singleton during its OWN `boot()`,
    but `services/db` only assigns that default inside `app.booted()` — which runs
    AFTER every provider's `boot()`. So the store/transport captured `undefined`
    and threw `Cannot read properties of undefined (reading 'connection')` on the
    first run, meaning `durable: true` never actually worked through a normal app
    boot. Both now resolve the `Database` from the container (`'lucid.db'`, bound in
    the database provider's `register()`), which is available during boot and at
    runtime alike.

  - **`LucidStateStore.createRun` / `updateRun` and `ensureSchema` ignored the
    configured connection.** `createRun`/`updateRun` ran their transaction on
    `this.db` (the default connection) instead of `this.client()` (the configured
    one), and `ensureSchema` provisioned tables on the default connection too — so
    on a store pinned to a dedicated connection, writes and schema landed where the
    reads never looked (`durable_workflow_runs` missing on the default connection).
    All three now go through the store's own connection. `createDurableTables` /
    `dropDurableTables` take an optional `connectionName` (backward compatible).

## 0.9.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/adonis-durable/pull/10) [`6b60f1e`](https://github.com/DavideCarvalho/adonis-durable/commit/6b60f1e844891128edc02adca1edc109a831a26a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix: `@adonis-agora/durable/testing` is now importable without `vitest` installed

  `vitest` has always been an _optional_ peer dependency — the intent is that any
  app can use the test harness (`createTestEngine`, asserts, fault injection,
  deterministic replay) with whatever test runner it likes (Japa, node:test,
  etc.), and only pay for `vitest` when it opts into the conformance suites.

  In practice that promise was broken: `/testing` is a single barrel, and two of
  its modules (`runAdmissionBackendContract`, `runStateStoreContract`) import
  `vitest` unconditionally to generate their `describe`/`it` suites. Because a
  barrel re-exports everything from every file it aggregates, importing
  `anything` from `/testing` — even just `createTestEngine` — pulled in both
  conformance generators and therefore required `vitest` to be resolvable, full
  stop. A real app on Japa hit exactly this: `Cannot find package 'vitest'`,
  forcing it to hand-roll the harness the library already ships.

  **Fix.** The two conformance generators move out of the `/testing` barrel into
  a new dedicated subpath, `@adonis-agora/durable/testing/conformance`. `/testing`
  itself no longer imports `vitest` anywhere in its module graph — verified by a
  regression test that statically walks the import graph rather than merely
  `import()`-ing it (which would pass vacuously inside this repo's own
  vitest-powered test suite regardless of the bug). `assertTransportConformance`
  stays in `/testing`: it's a plain async function with no `describe`/`it`, so it
  never needed `vitest` in the first place.

  **Breaking change** for anyone importing `runAdmissionBackendContract` or
  `runStateStoreContract` from `@adonis-agora/durable/testing` — switch that
  import to `@adonis-agora/durable/testing/conformance`. Every such consumer
  necessarily already has `vitest` installed (nothing from `/testing` was
  importable otherwise before this fix), so the only change needed is the
  import path.

### Patch Changes

- [#11](https://github.com/DavideCarvalho/adonis-durable/pull/11) [`bc0111c`](https://github.com/DavideCarvalho/adonis-durable/commit/bc0111c2dcb49ac397850d32a1e12c5a02c122a7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix a remote step result being silently destroyed, stalling the run forever

  With `transport: 'queue'`, the results queue is point-to-point: every engine
  instance on the backend polls it, so a step result can be popped by an instance
  that cannot resume the run — a pod mid-rolling-deploy that does not have the
  workflow registered yet, or a stale process left over from an older build.

  That instance did half the job. It wrote the `completed` checkpoint (which needs
  no workflow registry), then `resume()` threw `workflow … is not registered`, and
  the poll loop swallowed the throw into `failJob` — removing the only copy of the
  result. The run was left `suspended` with no `wakeAt`, which no recovery path can
  reach: the timer poller skips it (no timer), the recovery sweep skips it (not
  `running`), and a redelivered result would have been dropped as a duplicate. The
  run was stuck forever, and nothing was logged. Observed in production as a
  workflow whose first remote step completes and whose second step never starts,
  where a manual `engine.resume(runId)` always finished the run.

  Two things were wrong, and both are fixed:

  - `QueueTransport`'s poll loop now REDELIVERS a job whose handler threw
    (`retryJob`, delayed one poll interval) instead of destroying it, so a result
    reaches an instance that can act on it. It also reports the error through a new
    `onError` option (default `console.error`, matching `DbTransport`) — the
    invisible failure is exactly what made this so hard to find.
  - `completeRemoteResult` no longer treats an already-settled checkpoint as proof
    that the resume happened too. Settling the checkpoint and resuming the run are
    two durable effects and only the first is idempotent by its own state, so a
    redelivered result now re-drives the resume. Resuming twice is safe — the run
    lease admits one executor and replay is positional; dropping the last copy of a
    result is not.

  `MockAdapter` gained the matching `retryJob` + delayed-job semantics it was
  missing, so the bundled fake still mirrors what a real broker does.

## 0.8.1

### Patch Changes

- [#8](https://github.com/DavideCarvalho/adonis-durable/pull/8) [`9e3d803`](https://github.com/DavideCarvalho/adonis-durable/commit/9e3d803258986ffe27f9136bce5200f0d6bbdf00) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix DashboardProvider crashing every entrypoint on boot

  `DashboardProvider#boot()` resolved the router while the container was still
  booting, so `router` came back `undefined` and every entrypoint — `node ace`
  included — died before reaching user code. Any app that registered the
  provider could not boot at all.

  The router is now resolved inside `app.booted()`, once the container can
  actually hand it over.

  Shipped in [#7](https://github.com/DavideCarvalho/adonis-durable/issues/7) without a changeset, so the fix sat on master unreleased; this
  changeset carries it to npm.

## 0.8.0

### Minor Changes

- [`86819e0`](https://github.com/DavideCarvalho/adonis-durable/commit/86819e08666a307046e8845a7d9b9ed3685d7c53) - BaseWorkflow is the sole authoring form; `services/main`; dashboard login; signal/child/subscriber fixes

  **BREAKING — the `@Workflow` decorator is removed.** Author workflows with a
  `BaseWorkflow` subclass plus `static workflow = { name, version }`:

  ```ts
  // before
  @Workflow({ name: "charge", version: "1" })
  class ChargeWorkflow {
    async run(ctx: WorkflowCtx, input: Input) {}
  }

  // after
  export default class ChargeWorkflow extends BaseWorkflow {
    static workflow = { name: "charge", version: "1" };
    async run(ctx: WorkflowCtx, input: Input) {}
  }
  ```

  `workflowMeta()` now reads only the `static workflow` config; normalization is
  unchanged (version defaults to `'1'`). One authoring form means one thing to
  document, one thing to discover, and no decorator/metadata runtime.

  **Features**

  - `BaseWorkflow` with context-aware static `start`/`dispatch`. Call
    `ChargeWorkflow.start(input)` and it does the right thing by context: outside a
    workflow it enqueues on the engine and blocks until the run reaches a terminal
    state; inside one it starts a linked child and suspends the parent. `.dispatch`
    is the fire-and-forget twin, returning `{ runId }` without waiting.
  - `@adonis-agora/durable/services/main` — an idiomatic singleton import, so app
    code reaches the engine the way it reaches any other Adonis service.
  - Control-flow signal marker plus `isWorkflowControlFlowSignal`, so a workflow
    can tell a control-flow signal apart from a domain one.
  - Buffered events are now reliable: an event delivered before its waiter exists is
    no longer lost.
  - Dashboard built-in login screen via `dashboardAuth`.

  **Fixes**

  - Closed a lost-wake race in the signal waiter, and added the
    `removeSignalWaiter` SPI so a waiter can be torn down deterministically.
  - A child that fails to _start_ now surfaces the failure to the parent instead of
    stranding it. The parent used to wait forever on a child that never existed:
    the start was fire-and-forget, so nothing ever notified the parent. The child
    start is now deferred and its rejection is reported to the parent as a failed
    child result.
  - The Redis control plane now heals a silently-dead subscriber connection. A
    subscriber whose socket died without an error event stopped delivering messages
    while still looking healthy, and every wake-up routed through it was lost. A
    ping watchdog now detects the dead connection and forces a reconnect.
  - `BaseWorkflow.start` waits for terminal (matching the linked-child path), the
    steps hook is configurable, and the dashboard token comparison is
    constant-time.

  **eslint-plugin** — `no-nondeterminism` identifies a workflow's `run` body by the
  new authoring form (a `BaseWorkflow` subclass, or any class with a
  `static workflow` config) instead of the removed `@Workflow` decorator. Without
  this the rule would silently stop guarding every workflow in a 0.8 codebase.

## 0.6.1

### Patch Changes

- [`ef0a9da`](https://github.com/DavideCarvalho/adonis-durable/commit/ef0a9dab56eb492bb8daef4c06d56685ff42060d) - DbTransport now honors worker-pool namespaces. Previously the `db` transport
  ignored namespaces entirely: two engines on different namespaces sharing one
  transport table set would cross-claim each other's tasks/results/heartbeats/
  control and could stall runs (a result claimed by the wrong engine wrote a
  `completed` checkpoint before throwing `NamespaceMismatch`). Every transport
  row now carries a `namespace` column and every claim is scoped to it, matching
  the queue/event-emitter transports. `"default"` (and absent) is byte-compatible
  with the pre-namespace scheme; pre-existing transport tables are auto-upgraded
  (the `namespace` column is back-filled to `'default'`).

## 0.5.0

### Minor Changes

- [`9ae80aa`](https://github.com/DavideCarvalho/adonis-durable/commit/9ae80aa167fc27157b8e7c605bdb2805e6730dea) - feat: in-process EventEmitter transport; workflows codegen via Adonis assembler hook

  - New production **in-process** transport `transports.eventEmitter()` backed by a single Node `EventEmitter`: a single-process app runs real durable workflows with NO external infrastructure (no DB, no Redis, no broker). It decouples dispatch → worker → result over the event loop (mirroring a real broker), and funnels every step through `runStepHandler`, so the scoped context restore works identically. Distinct from the test-only `transports.memory()`. Selectable via `transport: 'event-emitter'` in `config/durable.ts`; the default is unchanged.
  - Workflows discovery now prefers a **build-time barrel** generated by an AdonisJS Assembler `init` hook (`@adonis-agora/durable/hooks/workflows`), exactly how core generates the controllers/events/listeners barrels via `IndexGenerator`. The dev server / test runner / bundler generates `.adonisjs/durable/workflows.ts` and the file watcher regenerates it on change; the provider imports it at boot instead of scanning `app/workflows` with `readdir`. Register it in `adonisrc.ts` under `hooks.init` (the `configure` command wires it for you). The runtime `readdir` scan is kept as a **fallback** so apps that don't register the hook keep working unchanged.

## 0.4.0

### Minor Changes

- [`d2591d0`](https://github.com/DavideCarvalho/adonis-durable/commit/d2591d0040bafb2301b41250e91a5d2961d9ad13) - Automatic cross-process context propagation + `app/workflows` auto-discovery and `make:workflow`.

  - The full Agora request context (userRef / tenant / traceId) now rides each remote task automatically and is restored on the worker before the step handler runs — `ctx.call(remoteStep, input)` sees the originating request's context with zero manual serialize/deserialize. Best-effort, no-op when `@adonis-agora/context` is not installed.
  - New class-based authoring convention mirroring `@adonisjs/queue`'s `app/jobs`: a `@Workflow` class per file under `app/workflows/` is auto-registered on the engine at boot (configurable via `workflowsPath`, opt-out with `false`), plus a `node ace make:workflow <name>` scaffold. `engine.register(name, version, fn)` remains the low-level escape hatch.

- [`6c31452`](https://github.com/DavideCarvalho/adonis-durable/commit/6c31452f14789fa98f20ea5f6164f421d76fc2df) - Scoped automatic cross-process context restore (was a no-op on db/queue workers); recursive workflow discovery; single-extension import.

  - Workers now restore the originating request's context by running each step handler INSIDE an active context store seeded from the task snapshot, via the new `Symbol.for('@agora/context:scope')` slot. The previous `@agora/context:set` path only populated an already-active store, so restore was inert on the db/queue workers (no active scope) — automatic propagation now actually works, and each task runs in its own scope (no cross-task bleed on a long-lived worker). Clean no-op when `@adonis-agora/context` is not installed.
  - The dispatch carrier is passed through opaquely (`context: () => accessor.get()`) instead of merging structured `userRef`/`tenantId`/`traceId` into it — the scope slot round-trips the whole snapshot, so the producer-owned carrier stays shape-opaque.
  - `app/workflows` discovery is now recursive, so nested `app/workflows/billing/charge_workflow.ts` is found (matching `make:workflow`'s nested-path scaffolding). Only the environment-appropriate module extension is imported, so a built app (`.js`) and a dev app (`.ts`) never double-register the same workflow.

## 0.3.0

### Minor Changes

- [`6b47d1a`](https://github.com/DavideCarvalho/adonis-durable/commit/6b47d1a7d0bc6f76e5b6ebe704c3ea8cfe025d53) - Require AdonisJS v7 (bump @adonisjs/\* peers; Lucid 22, Queue 0.6)

## 0.2.0

### Minor Changes

- [`2ecedd7`](https://github.com/DavideCarvalho/adonis-durable/commit/2ecedd7984641208ba59088535ed8c165b5992b5) - Redis control-plane driver for cross-pod cancellation + lifecycle-event fan-out (multi-replica).

  Adds `controlPlanes.redis({ connection: 'main', prefix? })` and the `RedisControlPlane` class — a Redis pub/sub `ControlPlane` that broadcasts workflow lifecycle events and cancellation across every engine replica. Without it, a `cancel` issued on one pod never reaches the pod running the run and a dashboard pod can't live-tail runs executing elsewhere. The channel (`${prefix}-control`) and payload match the NestJS BullMQ transport, so an AdonisJS fleet interoperates with a NestJS fleet on the same Redis. `controlPlane` config now accepts a `ControlPlaneFactory` as well as a ready instance; `@adonisjs/redis` stays an optional, lazily-imported peer. Omit `controlPlane` and the engine remains local-only (single instance).

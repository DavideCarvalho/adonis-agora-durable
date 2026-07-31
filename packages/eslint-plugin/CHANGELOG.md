# @adonis-agora/durable-eslint-plugin

## 0.2.1

### Patch Changes

- [`878a628`](https://github.com/DavideCarvalho/adonis-durable/commit/878a628b3bd83b9f2e69f57e23e0af4a8d402988) - Build: `pnpm build` can no longer exit 0 having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`, so removing `dist/` and leaving the buildinfo behind (a plain `rm -rf dist`, then a build) made the compiler conclude every output was current and emit nothing. The `copy:stubs` half is a plain `cp`, so it still ran: the result was a `dist/` holding `assets/` and `stubs/` and zero `.js` files, from a build that reported success. Turbo then wrote that empty directory into its cache as a successful `build` and replayed it — `>>> FULL TURBO` — on every later run, including from an otherwise clean tree, so one such build poisoned the cache for good.

  The build now removes `dist/` before compiling and compiles through a `tsconfig.build.json` with `incremental: false`, so it keeps no state that can disagree with `dist/`, and a new post-condition fails the build outright if `dist/` ends up without JavaScript or without the package entrypoint. That check runs inside the `build` script rather than in CI, which is what makes it cover `prepack` — the path a manual `pnpm publish` takes, and the one place turbo was never involved. `build` and `typecheck` also stop sharing a single buildinfo file, so the two turbo tasks can no longer race on it or restore each other's incremental state from cache.

  No published version is known to be affected. CI builds from a cold checkout, so the trigger (removing `dist/` from a tree that already had a buildinfo) does not arise there, and `@adonis-agora/durable`'s spec that imports the built `dist/src/index.js` hard-fails under CI when the build is missing — both release workflows run the suite before publishing. The exposure was a developer machine and any cache shared from one. There is nothing to re-install or re-publish because of this.

## 0.2.0

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

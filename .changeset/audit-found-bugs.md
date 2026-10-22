---
'@adonis-agora/durable': patch
---

Fixes for bugs found while auditing the docs against the 0.51 code.

- `ctx.webhook().wait()` consumes a callback that arrived before the wait. `engine.signal` had buffered it, but the wait never read the buffer, so the callback was lost and the run waited forever. The wait now checks the buffer, registers, then checks again, like `ctx.waitForSignal`. The dashboard webhook route still answers `404` to a callback that arrives before the wait.
- `ctx.callEntity` and `ctx.signalEntity` are exactly once across replay. A replay of a `callEntity` still waiting for its reply used to send the operation again, and a turn that died after a `signalEntity` dispatch sent it twice. The operation is now stored durably, tagged with the caller's `<runId>:<seq>`, before the caller checkpoints. `callEntity` records a pending intent that it marks as sent with a conditional write. The entity skips a copy re-sent with the same id.
- A child moved to `dead` by recovery (`maxRecoveryAttempts`) now notifies its parent right away as a failed child (`ctx.child` throws, `ctx.all`/`allSettled` record it). Before, the parent waited for its reconcile wake.
- An empty-string namespace is the default pool. An engine configured with `namespace: ''` stamps and polls `'default'`. The Lucid and in-memory stores write `''` as `'default'`, read legacy `''` rows back as `'default'`, and match those rows with every `'default'` filter (polls, recovery, `listRuns`, scoped views, schedules).
- `node ace make:workflow OrderWorkflow` (or `order_workflow`) no longer generates `OrderWorkflowWorkflow`.
- Event triggers: a start or publish that fails (unregistered workflow, invalid input, quota, store error) is reported through the bridge's new `onError` option (default `console.warn`). Before, it was an unhandled rejection. Other background promises now catch their rejections too: the run-request responder's tenant-event re-publish, the Redis admission backend's first liveness write, the bullmq heartbeat handler, the dashboard's audit and hook-warning logging (including an async `audit` hook), and the provider's unserved-onError-routes report.
- A tenant pod's top-level `partition` and `instanceId` now reach its transport (queue, db, bullmq, eventEmitter), so it consumes the `<name>@<tenant>` queues the control plane dispatches to. A value set on the transport still wins.
- New `transportPool` config: transports listed there are built next to `transport`, in failover order, with the same consumer deferral, namespace and shutdown. `ctx.step(..., { transport })` can pin any of them by name. Pinning a transport that isn't built now fails with an error that lists the built ones, and `default` still means the primary transport.
- bullmq: a process with deferred consumers (`node ace`, `consumers: 'auto'` in the console or REPL, or `'never'`) no longer advertises worker liveness until it starts consuming.
- db transport: payload columns are `longtext` on MySQL instead of `text`, which capped them at 64KB. Existing tables are widened at boot, and the migration stubs are updated.
- `transports.db()` forwards `workerKeysCacheMs`.
- `controlPlanes.redis()` (an `@adonisjs/redis` connection) gets the subscriber PING watchdog and a `pingIntervalMs` option.
- The bullmq transport and `RedisControlPlane` fall back to the default `pingIntervalMs` when given a negative, NaN, Infinity or out-of-range value. Before, the watchdog pinged about every millisecond.
- `workflowsPath: false` no longer skips registering `app/steps` or starting the run-request responder.
- Lucid store: `cancel` and `requeue` no longer fail with an unknown column on a runs table that predates `awaiting_decision_task_id` (`autoSchema: false` with an older migration).
- queue transport: a control plane without a worker-key store now warns once that it drops forwarded worker advertisements.
- queue, db and bullmq transports: when one `onDecision` handler fails, every handler still runs to completion and each failure is reported before the decision is redelivered. Before, the redelivery started while the other handlers were still running, so they ran again concurrently.
- `InMemoryStateStore.withScope` views share the store's state by reference, so counters no longer drift between a view and its base.
- The `create_durable_tables` migration stub comment now lists all seven tables.

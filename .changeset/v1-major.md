---
"@adonis-agora/durable": major
"@adonis-agora/durable-dashboard": major
"@adonis-agora/durable-eslint-plugin": major
---

1.0. The breaking changes, with before/after snippets, are in [Migrating to 1.0](https://davidecarvalho.github.io/agora/docs/durable/migrating-to-1-0).

`@adonis-agora/durable`:

- **`Wf.start` throws when the run does not complete.** Outside a workflow, a run that ends `failed`, `cancelled` or `dead` now throws the same `FatalError` `ctx.child` throws (`run "<runId>" failed: <reason>`, with the run error's `code` and `details`) instead of resolving with `undefined`. `Wf.start` also takes `timeoutMs` (new `WorkflowStartOptions` type), which bounds the wait.
- **The Redis control plane channel includes the namespace.** `controlPlanes.redis` / `RedisControlPlane` broadcast on `<prefix>-<namespace>-control` when the engine has a namespace, matching the `bullmq` transport's names and the NestJS and Python workers. A namespace-less or `default` engine stays on `<prefix>-control`. Wire change: deploy every pod of a namespace together, and drop a `prefix: 'durable-<namespace>'` workaround. New `namespace` option, and an optional `ControlPlane.useNamespace` hook the engine calls.
- **The dashboard update route is `POST <path>/api/runs/:id/updates/:name`** (was `update/:name`), matching the Aviary dashboard API. No alias.
- **The transports' `group` option is removed** from `transports.queue`, `transports.db`, `transports.eventEmitter` and the `QueueTransport`, `DbTransport` and `EventEmitterTransport` constructors. It had no effect; use `partition` for separate worker pools.
- **`RunSchedulesOptions.sleep` is removed.** It was no longer called.
- **`ProxyRunGateway` no longer reads the pre-0.50 unknown-verb reply** (an `unknown run-request verb` message with no `code`), nor an empty `ok` reply, as "the control plane does not know this verb". It relies on the `unsupported-request` code every 0.50+ control plane sends, so upgrade a control plane older than 0.50 before its tenant pods.

`@adonis-agora/durable-dashboard`: the console's `update` call targets `POST <path>/api/runs/:id/updates/:name`, which only a 1.0 server answers.

`@adonis-agora/durable-eslint-plugin`: no breaking changes; released as 1.0 with the rest of the family.

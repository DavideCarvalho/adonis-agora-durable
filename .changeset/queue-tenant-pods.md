---
'@adonis-agora/durable': minor
---

The `queue` transport now carries remote workflow turns and store-less `tenant` pods, which used to need `bullmq`.

- Remote workflows: `dispatchWorkflowTask` / `handleWorkflow` / `onDecision` and streamed step events. A turn rides the workflow name's task queue next to its steps (told apart by shape); decisions return on `<prefix>:decisions`, local steps on `<prefix>:step-events`. Every `onDecision` handler sees each decision, so several remote workflows can share one transport.
- Tenant pods: run starts and read/control requests are jobs on `<prefix>:start-run` and `<prefix>:run-request`. Replies, which `bullmq` broadcasts on Redis pub/sub, go to a queue of the requesting instance only (`<prefix>:run-replies:<instanceId>`), so two pods never receive each other's replies. Live-tail events are pushed to `<prefix>:tenant-events:<instanceId>` of every pod subscribed to that tenant: a pod announces its subscriptions on `<prefix>:inbox-registrations` and the control plane records them in its worker-key store, so the pod needs no database. A pod with no key store forwards its worker advertisement the same way, so the control plane still sees its workers. A control-plane janitor drains the queues of pods that died. New options: `inboxTtlMs`, `tenantSubscribersCacheMs`, `inboxSweepIntervalMs`.
- The provider already picks a transport for the `tenant` and `control-plane` roles by its methods, so `transport: 'queue'` now works for both. It also calls a new optional `Transport.useTenantRole()` hook on a tenant pod's transport; `bullmq` does not implement it and is unchanged.
- `verifyTenant` is now typed on the `standalone` role too. A `standalone` or `control-plane` engine whose transport carries this protocol starts the run-request responder, as it already did on `bullmq` — so a `standalone` app on `queue` now starts it, and logs a warning at boot unless `verifyTenant` is set.

Compared with `bullmq`: replies and events are polled rather than pushed; a new subscription can miss events published in its first second or so; each event costs one job per subscribed pod; and live-tail needs a worker-key store on the control plane.

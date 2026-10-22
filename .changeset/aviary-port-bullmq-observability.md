---
'@adonis-agora/durable': minor
---

BullMQ, run-gateway and observability fixes and features ported from the NestJS library.

**BullMQ transport**
- Pub/sub subscribers heal after a silent connection loss. The heartbeat, run-reply and tenant-event subscribers never write on their own, so a VPN/NAT/idle timeout that dropped their TCP connection left them deaf (Redis had dropped the subscription while ioredis still reported `ready`) until the process restarted. A shared watchdog now PINGs each one every `pingIntervalMs` (default `30_000`, `0`/`false` disables) and reconnects a dead one, so ioredis resubscribes. Each subscriber also gets an `error` listener (the first error of a burst goes to `onError`) instead of risking an unhandled `error` event.
- New opt-in `stepTimeoutMs`: a step handler still running at the ceiling is failed RETRYABLE, so a wedged `await` can no longer hold its job forever (BullMQ renews the lock on a timer, so such a job never stalls).
- New `readAllWorkerDescriptors()` / `readAllWorkerHeartbeats()` fleet-wide reads.

**Run gateway**
- `RunRequestResponder` always replies. A gateway that threw in `listRuns`, `workerHealth` or the pre-verb ownership read, or a tenant verifier that threw, left the request unanswered and the tenant waited out `requestTimeoutMs`. An unknown verb is now answered with the `unsupported-request` code before the gateway is touched.
- Run detail survives version skew: against a control plane older than `getRunDetail` / `getFanMembers`, `ProxyRunGateway` builds the detail and fan pages from `getRun` + `getCheckpoints` + `getRunChildren` and summarizes on the tenant, remembering the old control plane for a minute.
- New gateway verbs, in the NestJS shapes: `retry`, `continue`, `retryWithInput`, `runFacets`, `runValueFacets`, `waitingFor` (optional on the interface, implemented by both gateways, tenant-scoped by the responder). A tenant pod's console now retries in place, continues breakpoints, fixes and replays, fills its value pickers server-side and names what a suspended run waits on.

**Observability**
- A fleet with a control plane counts each lifecycle event once. Every pod used to forward the events it heard from other pods too, so Telescope, `collectMetrics`, `attachDurableMetrics` and `attachDurableOtel` counted (or traced) each event once per pod. They now handle only local events (`isRemoteEvent(event)`; `attachDurableDiagnostics(engine, { includeRemote: true })` restores the old behaviour), and Telescope's entry-backed providers collapse copies already recorded (`dedupeRunEvents`).
- Telescope: the state-breakdown donut showed completed in red and failed in blue; the "Starved worker groups" panel is renamed "Worker health"; a new per-instance **Workers** table (`durable.workerStatus`).
- Dashboard: `GET <path>/api/metrics` (Prometheus counters plus backlog and worker gauges), `GET <path>/api/runs/:id/events/:key` (the latest `ctx.setEvent` value) and `POST <path>/api/webhooks/:token` (resumes a run parked on a `ctx.webhook()`; webhook tokens only, only while a run waits on it, behind the console's guard).
- `currentStep()`: the step logger, reachable from code a step calls without being handed it, on local and remote steps.

**Engine**
- `StartOptions.version` pins a start to a registered version and throws for an unregistered one, never falling back to the newest.
- `engine.remote(name, { group, version? })` registers a remote workflow without building the executor by hand.
- `engine.workflowDirectory()` / `engine.announcedWorkflows()`: every workflow the live fleet can run in this engine's partition, declared or observed, and why the list is empty when it is.

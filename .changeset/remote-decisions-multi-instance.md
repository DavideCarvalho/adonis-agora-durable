---
'@adonis-agora/durable': minor
---

Remote workflow turns are now safe with several engine replicas, and a turn whose worker died is re-driven instead of hanging or failing the run.

**Fix.** `RemoteWorkflowExecutor` waited for each turn's decision in an in-memory map. On `bullmq` and `queue`, `<P>-decisions` is a point-to-point queue every replica consumes, so a decision was often taken by a replica that had not dispatched the turn. It found no waiter and dropped the decision, and the dispatcher waited forever with the run leased. The executor also numbered turns with a per-process counter, so two replicas could send the same `taskId` (the `db` transport then ignored the second turn). Now:

- The engine mints a random `taskId`, records it on the run (`WorkflowRun.awaitingDecisionTaskId`), suspends the run and releases its lease, and only then enqueues the turn. A decision cannot arrive ahead of its marker.
- Every engine that registers a remote workflow consumes decisions. The replica that takes one leases the run, checks that it still awaits that `taskId`, and applies the decision durably. A stale or duplicate decision is dropped.
- A wake that lands while a turn is out (a step result, a signal) no longer dispatches a second turn over it.
- `waitForRun` does not resolve on the suspend of a run awaiting a turn.

**New: `remoteAdvanceSilenceMs`** (engine option and `config/durable.ts`). A turn with no decision and no run-scoped heartbeat for this long is re-dispatched by the timer poller under a fresh `taskId`, with the same history. A run-scoped heartbeat (`{ runId, seq: 0, group }`, no `stepId`) pushes the deadline forward, throttled to one write per half window; the Python `durable-worker` already sends them, and the `bullmq`, `queue` and `db` transports now send one every 5 s while a TypeScript worker replays a turn. A `RemoteWorkflowExecutor`'s `timeoutMs` is now the per-workflow version of this window (the shorter wins) and re-drives the turn instead of failing the run. An inline executor (one that returns its decision in-process) that goes silent past the window releases its lease to crash recovery rather than failing; it throws the new `RemoteWorkflowTimeout`. Unset, a turn waits for its decision as before.

**Convention routing is per run and tenant-aware.** A workflow started by name with no registration routes to the group of the run's namespace, `<name>@<tenant>` (bare for the default namespace), the same rule steps follow. An operator starting a tenant's run reaches the tenant's worker, and the group is re-checked on every start. In a transport pool the turn goes out on the transport that reports the live group.

**Breaking for direct callers of the executor:** `WorkflowExecutor.advance` is now optional and joined by `dispatch(run, history, taskId, pendingSignals?)`, `subscribeDecisions(handler)` and `decisionTimeoutMs`. `RemoteWorkflowExecutor` implements `dispatch` and no longer has `advance`. `Heartbeat.stepId` is optional.

**Schema.** `durable_workflow_runs` gains a nullable `awaiting_decision_task_id` column. `createDurableTables` creates it, and `ensureSchema()` adds it to an existing table at boot (reported once, like any repair).

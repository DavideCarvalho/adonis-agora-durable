---
'@adonis-agora/durable': patch
---

Terminal runs are immutable, and workflow primitives fail fast inside step bodies.

- `cancel()` on a `failed` run is now a no-op, like on `completed`/`cancelled`/`dead`: it returns the current state, never rewrites the run to `cancelled`, and never cascades to the run's children. Previously cancelling a failed run relabelled it and cancelled its live children — e.g. the next queued chat turn an agent queue had already started as a child of the turn that failed. `cancelWhere` inherits the fix.
- `recheckWaitSeqs` and every other implicit wake-up (a delivered signal or child completion, a late step result, a due timer, a redelivered dispatch, a queue-slot wake) no longer re-drive a `failed` run. Only an explicit retry does: `requeue` (dashboard retry) or a direct `resume(runId)` call.
- New `NestedWorkflowCallError` (a `FatalError`, code `nested_workflow_call`): calling a ctx primitive (`ctx.startChild`, `ctx.child`, `ctx.step`, `ctx.sleep`, `ctx.sideEffect`, …, or a `BaseWorkflow.start()`/`.dispatch()` static through the ambient ctx) from inside a `ctx.localStep`/`ctx.transaction`/`ctx.sideEffect`/`ctx.now` body now throws at the call site. Before, the nested call wrote a journal entry that replay never reproduces, and the run failed later with a `NonDeterminismError`. Journals recorded before this change (where the nested entry is already at that position) still replay unchanged.
- Dispatched step handlers run outside the ambient workflow ctx, so in-process transports behave like remote workers: `BaseWorkflow.dispatch()` in a handler starts a top-level run and does not write into the suspended parent's journal.

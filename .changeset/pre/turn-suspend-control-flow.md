---
"@adonis-agora/durable": patch
---

The suspend a thin-worker workflow op (`WorkflowTurnCtx.step`, `sleep`, `waitSignal`, `gatherCalls`, …) throws is now a control-flow signal: `isWorkflowControlFlowSignal(error)` returns `true` for it, so a `catch` in the body can rethrow it instead of running cleanup that emits extra commands into the turn.

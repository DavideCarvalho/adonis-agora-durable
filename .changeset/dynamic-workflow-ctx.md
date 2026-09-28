---
'@adonis-agora/durable': minor
---

New `DynamicWorkflowCtx` type — port of nestjs-durable#337: `WorkflowCtx` with ONE string-addressed signature for each of its overloaded methods (`step`, `child`, `startChild`, `all`). Every `WorkflowCtx` is assignable to it, so code that drives the ctx by names (a graph interpreter) and test fakes can depend on it — or on a `Pick` of it — instead of re-declaring a narrow interface and casting `ctx as unknown as …`. A type-test pins the assignability.

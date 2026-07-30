---
'@adonis-agora/durable': patch
---

`discoverWorkflows` now hands back a constructor you can actually call. `DiscoveredWorkflow.cls` was typed as `WorkflowClass`, which is deliberately `abstract new (...) => ...` — that shape exists so any `BaseWorkflow` subclass can be *referenced* (`ctx.child(Cls)`, `engine.start(Cls)`), and an abstract constructor type is by definition not newable. So `new (await discoverWorkflows(dir))[0]!.cls()` failed to compile with `TS2511: Cannot create an instance of an abstract class`, even though the value is a real, instantiable class and `registerWorkflowClass` does exactly that `new Ctor()` internally, through a local cast that quietly asserted the concrete shape the public type withheld.

`cls` is now a new exported `DiscoveredWorkflowClass` — the concrete `new () => { run(ctx, input) }` shape the module already relied on. Concrete constructor types stay assignable to `WorkflowClass`, so every reference-style use of a discovered class keeps compiling; the change only removes an error. Type-level only: no runtime behaviour changed, and the same `registerWorkflowClass` cast is now expressed in terms of the exported type instead of an inline duplicate.

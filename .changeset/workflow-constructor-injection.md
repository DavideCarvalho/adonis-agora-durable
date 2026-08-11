---
'@adonis-agora/durable': patch
---

Workflow classes can now use constructor dependency injection

`registerWorkflowClass`/`registerWorkflowsFromDir`/`registerWorkflowsFromBarrel` accept an optional
**workflow class factory**. The `durable_provider` passes `(Ctor) => app.container.make(Ctor)`, so a
workflow's constructor is resolved by the AdonisJS IoC container — constructor parameters are
injected just like `@adonisjs/queue` jobs. Without a factory (library/tests), the class is still
instantiated with `new Ctor()` as before. The factory may return a promise (the container's `make`
is async), so the registration functions are now async.

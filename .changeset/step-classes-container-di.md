---
"@adonis-agora/durable": minor
---

`app/steps` classes are resolved through the AdonisJS container on every step execution, so a `@Step` body that uses a constructor-injected (`@inject()`) service has it. Discovery used to build every step class once with a bare `new Ctor()`, so those dependencies were `undefined` when the handler ran. The provider's embedded worker and `node ace durable:worker` both pass `(Ctor) => app.container.make(Ctor)` now.

The instance is resolved per execution, as `@adonisjs/queue` does for a job: a service that isn't a container singleton is fresh each time, and an `app.container.swap(Service, () => fake)` made after boot is what the next execution receives. A failure to resolve the class fails that execution.

`registerStepsFromDir(server, dir, factory?)` and `registerStepsFromBarrel(server, barrel, factory?)` take an optional third argument, a `StepClassFactory` (`(Ctor) => instance`, may be async), called on each handler call to build the class with `@Step` methods. Without it nothing changes: each class is built once with `new Ctor()` at registration. `defineStep` handlers are never passed to it. `collectSteps` and `registerSteps` stay synchronous and keep `new Ctor()`.

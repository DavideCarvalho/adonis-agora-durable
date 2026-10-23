---
"@adonis-agora/durable": minor
---

Derive every workflow's `origin` (the npm package that declared it) instead of requiring an opt-in. The engine resolves the nearest `package.json` `name` from, in order: the class's declaring file (captured by `@Scheduled` / `@OnEvent` / `@OnDiagnostic`), the discovered module's file (`app/workflows/…`, a built `build/…`, the generated barrel via the app root), or the file calling `registerWorkflowClass` / `engine.register` (a lib registering its own workflows is attributed to the lib). An explicit `static workflow.origin` / `register` `origin` option still wins, and `workflowAnnouncement` applies the same precedence. Derivation never guesses: an unresolvable workflow has no origin, and the provider logs the discovered workflows it couldn't attribute once at boot. `registerWorkflowsFromBarrel` takes an optional `{ appRoot }`, and `registerWorkflowsFromDir` / `registerWorkflowsFromBarrel` now return each workflow's resolved `origin`.

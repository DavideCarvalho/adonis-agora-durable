---
'@adonis-agora/durable': patch
---

Fix: `node ace add @adonis-agora/durable` now actually configures the package. The `configure` hook was only reachable through the `./configure` subpath, which AdonisJS never reads — it imports the package main and looks for `configure` there, so the command silently warned and did nothing (`Cannot configure module ... does not export the configure hook`). The package main now re-exports `configure`, so `node ace add` registers the provider, publishes `config/durable.ts` + `config/durable_dashboard.ts`, and publishes the migration stubs as documented.

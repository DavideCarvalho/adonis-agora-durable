---
'@adonis-agora/durable': patch
---

Fix: the published migration stub (`node ace configure @adonis-agora/durable` → `migration:run`) now creates `last_heartbeat_at` and `heartbeat_progress` on `durable_step_checkpoints`. Those columns were only ever created by the `autoSchema: true` auto-schema path, never by the migration — so an app provisioned via `migration:run` (the documented path, and the only one when `autoSchema: false`) silently lost step-level heartbeat persistence: `LucidStateStore.recordStepHeartbeat` writes both columns on every beat, the engine swallows the resulting UPDATE error, and no heartbeat data ever showed up in the dashboard or in `durable:runs --stale`.

Upgrade note for existing installs: apps on `autoSchema: true` (the default) pick up the two columns automatically on next boot — `createDurableTables` carries an in-place auto-migration for them. Apps on `autoSchema: false` need a follow-up migration adding `last_heartbeat_at` (bigInteger, nullable) and `heartbeat_progress` (text, nullable) to `durable_step_checkpoints`.

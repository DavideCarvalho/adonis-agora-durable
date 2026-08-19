---
'@adonis-agora/durable': minor
---

Export the ace-command building blocks and the schema-logger types from the package root.

`runWorkerLoop`, `runTick`, `listRuns`, `retryRun`, `renderRunsTable`, `attachLiveness`, `filterStale`, `staleHint`, `parseDurationMs` and `DEFAULT_STALE_MS` back `durable:work` / `durable:runs` / `durable:retry` and were documented as composable, but lived in an internal barrel with no `exports` entry — importing any of them failed. `CreateDurableTablesOptions` and `DurableSchemaLogger` are exported too, so the third argument of `createDurableTables(db, connection, { logger })` is nameable in a migration.

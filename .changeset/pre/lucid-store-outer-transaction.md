---
"@adonis-agora/durable": patch
---

The Lucid store works inside an app's own transaction again (AdonisJS `wrapInGlobalTransaction()` in tests):

- **A start that finds its run id taken no longer aborts the surrounding transaction.** `createRun` inserts with `ON CONFLICT (id) DO NOTHING` (Postgres, SQLite) or a no-op `ON DUPLICATE KEY UPDATE` (MySQL) and rejects with the new `RunAlreadyExistsError` when nothing was written, so no statement fails. Before, the plain INSERT's duplicate-key error aborted the outer Postgres transaction, and every later query in the test failed. `insertCheckpointIfAbsent` uses the same insert.
- **No overlapping queries on a transaction's connection.** The Postgres hot path is skipped when the store's client is a transaction, and the store's calls on a transaction run one at a time, so a background run pickup can no longer send a query while another is in flight (which `pg` deprecates and pg 9 removes) or land inside a savepoint that is being rolled back.

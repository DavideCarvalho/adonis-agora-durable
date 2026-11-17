---
'@adonis-agora/durable': minor
---

Postgres: the worker's listing of settled runs that still owe a lifecycle event (every 10s) now reads a partial index, `durable_runs_lifecycle_pending_idx`, instead of the whole runs table (measured 29 ms → 0.014 ms on a 138k-run table). The schema check builds it with `CREATE INDEX CONCURRENTLY` once the locked check is done, so writes to the runs table go on meanwhile, and records schema revision 7 only once the index is valid (a failed build logs a warning and the next boot retries). With `autoSchema: false`, add a migration that calls `createDurableTables`, or create the index yourself (the SQL is in the Lucid store docs). MySQL and SQLite are unchanged.

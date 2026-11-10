---
"@adonis-agora/durable": patch
---

The Lucid store's Postgres hot path names its columns instead of `select *` / `returning *` (run reads and lease, checkpoint read, buffered signals and events). With `preparedStatements: true`, a `*` statement prepared before the schema added a column (another pod's boot during a rolling upgrade) failed with "cached plan must not change result type". The run reads list the later-wave columns the table actually has, probed once per store. `preparedStatements` stays off by default; the Lucid store docs now say when it is safe to turn on (direct Postgres, or PgBouncer 1.21+ with `max_prepared_statements > 0`) and how to check.

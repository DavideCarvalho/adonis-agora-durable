---
'@adonis-agora/durable': minor
---

Lucid store schema fixes, and store-level batching and aggregates.

**Schema (Lucid).**

- On MySQL the JSON columns (run and checkpoint `input`/`output`/`error`, `events`, `tags`, `search_attributes`, `heartbeat_progress`, the buffered payloads, the schedule documents) are `longtext`. MySQL `text` stops at 64KB: a larger output or event log was rejected (strict mode) or cut off and then failed to parse on read. An existing `text` column is widened with one `ALTER TABLE … MODIFY` per table and reported in the repair warning. MySQL rebuilds the table for it, so run `node ace migration:run` in a maintenance window for a large checkpoints table. Postgres and SQLite DDL is unchanged.
- `createDurableTables` records a fingerprint (`DURABLE_SCHEMA_REVISION` plus the collation) in a new one-row table, `durable_schema_meta`. A boot against a current schema reads that row and returns: two statements instead of a probe per table, column and index. A missing or stale row runs the full check under a cross-process lock (`pg_advisory_xact_lock` on Postgres, `GET_LOCK` on MySQL, none on SQLite), so pods booting together against a fresh database no longer race the same `CREATE TABLE` (on the previous release, 7 of 8 concurrent boots failed on both Postgres and MySQL). `{ force: true }` runs the check behind a current marker. `dropDurableTables` drops the marker too.
- New `collation` option (`stores.lucid({ collation })`, `createDurableTables(db, name, { collation })`), MySQL only: new durable tables are created with it, and an existing one with another collation is converted, so JOINs with the app's tables stop failing with `Illegal mix of collations`. Defaults to the Knex connection's `collate` setting when it has one.
- New index `durable_step_checkpoints_group_idx` on `(run_id, parallel_group, seq)`, for the run detail's per-fan reads.
- A JSON column that does not parse now reads back as `undefined` for that field instead of throwing. One damaged row used to fail `listRuns`, the run detail and every other read that touched it. Each damaged row and column is reported once with `console.warn`; route it with `onCorruptJsonColumn(reporter)`.

**New optional `StateStore` members**, implemented by the Lucid and in-memory stores, forwarded by `CodecStateStore`, and required by the conformance kit:

- `saveCheckpointsIfPending(checkpoints)`: `saveCheckpointIfPending` for a batch, atomic as a whole. A run's step results that land together (`resultConcurrency > 1`) are settled in batches of up to 256: one batched write, the step fan's barrier asked once, one resume. A batch of one takes the single-result path unchanged. A rejected batch write is retried row by row, so one bad row fails only its own result. Without the method each result gets its own write.
- `checkpointStats(runId, { group? })` and `queryCheckpoints(runId, query)`: a `GROUP BY` over a run's checkpoints, and paged, filtered reads. `engine.getRunDetail` / `engine.getFanMembers` (new) and the gateways build the summarized run detail and fan pages from them, reading a few rows per wide fan instead of the whole history.
- `deleteRuns(runIds)`: retention and `purgeRuns` delete a pass with one call (a few `IN (...)` statements in one transaction) instead of four statements per run.
- `runFacets(query)`: `(status, origin)` counts in one `GROUP BY`; `engine.runFacets(query)` uses it.
- `pruneBufferedEvents(publishedBefore, limit)`: deletes expired buffered events across every name.

**Dashboard.** `GET /runs/:id` and `GET /runs/:id/fans/:group` send an `ETag` with `Cache-Control: private, no-cache` when the store has the aggregates. A poll whose `If-None-Match` still names it gets a bare `304`, answered without reading a checkpoint row. The browser adds the header to the console's polls itself. `?full=true` and stores without the aggregates answer in full as before.

**Config.** `eventBufferTtl` (duration): a buffered event older than this is never delivered, and the worker tick's retention phase deletes expired ones. `scopeReads: true` (with `namespace`): the engine reads through `store.withScope({ namespace })`, a view whose run reads only see that namespace; writes are unaffected. `LucidStateStore` and `InMemoryStateStore` have `withScope`.

---
"@adonis-agora/durable": minor
"@adonis-agora/durable-dashboard": minor
---

The runs board pages by cursor, so loading more no longer re-reads the runs above or counts the table on every page.

- `GET /runs` accepts `first`/`after` and answers `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev }, statuses }`. It seeks past the last run's `(createdAt, id)` with no `countRuns`. `page`/`size` keep the offset envelope and its `total`.
- `RunQuery.after: { createdAt, id }` (new type `RunListPosition`) pages by position: strictly past it in `(createdAt DESC, id DESC)` order, `page` ignored. Both built-in stores implement it. `listRuns` now breaks ties on `createdAt` by `id`, so runs created in the same millisecond keep one order across pages. A store that ignores `after` ends the board's listing instead of repeating runs.
- The board's infinite scroll follows `nextCursor`. Its header shows the loaded count (`120+ runs`) instead of a total.
- New migration `add_durable_run_list_indexes` (published by `configure`), plus `createDurableRunListIndexes` / `dropDurableRunListIndexes`. It adds `(status, created_at, id)` on the runs table for the status chips, built `CONCURRENTLY` on Postgres. Opt-in: run it once on existing installs (see the Lucid store docs).

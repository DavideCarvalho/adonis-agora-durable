---
'@adonis-agora/durable': minor
---

`createDurableTables` now creates `durable_runs_retention_idx` on `(status, updated_at, workflow)`
(Postgres: `CONCURRENTLY` after the boot's schema lock; elsewhere a plain index), and
`DURABLE_SCHEMA_REVISION` goes to 8 so every existing install runs the full check once and picks it
up.

It is what the retention sweep reads. A pass asks for `status IN (…) AND updated_at <= cutoff`
(+ a `workflow IN (…)` when the policy is scoped); with no index that was a full scan of the runs
table on every pass, once a minute. On a 36 568-run / 669 MB install it read ~160 MB of buffers per
pass, 674 passes a day — 372 s of database time, 76 passes over 1 s, one at 8.9 s — to delete nothing,
since a healthy install expires a handful of runs a day. Measured on a production-shaped table: a
scoped pass with nothing expired goes 40.9 → 0.47 ms (13.1 k buffers → 8); a pass with a full
backlog 67.9 → 18.6 ms. Dropping `updated_at` from the index falls back to a Seq Scan, and dropping
`workflow` makes a scoped pass fetch 21 k heap rows to filter them away.

The write cost was measured rather than assumed: `workflow` does not change per run, and `updated_at`
is only rewritten by a terminal settle, which already rewrites `status` — indexed since the first
schema. So the index adds an entry to an already non-HOT write and converts no HOT update into a
non-HOT one. The lease CAS (2 296/day, 100% HOT) is unchanged; a settle is 1.19 → 1.25 ms and +150 B
of WAL/row (~110 kB/day at 703 settles/day). Nothing in the engine rewrites `updated_at` alone, which
is the only shape that would pay.

New exports: `RUN_RETENTION_INDEX`, `RUN_RETENTION_INDEX_COLUMNS` and `ensureBootIndexes` (the
`CONCURRENTLY` builder both boot indexes now go through; `ensureLifecyclePendingIndex` stays and
delegates to it).

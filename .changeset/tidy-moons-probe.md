---
'@adonis-agora/durable': patch
---

Index-only schema repair now PROBEs the catalog before `CREATE INDEX` instead of blindly creating and swallowing the `already exists` failure. The old pattern is safe only in autocommit: inside an open transaction (e.g. a test suite's global transaction, or `ensureSchema` run under one) the failed `CREATE INDEX` aborts the whole transaction, and the swallowed error leaves callers with a poisoned transaction and no signal — every later statement cascades with "current transaction is aborted". The probe is a read-only catalog `SELECT` (`pg_indexes` / `sqlite_master` / `information_schema.statistics` by dialect; dialects outside the store's three declared targets keep the legacy best-effort path), so the repair never touches the database unless the index is genuinely missing — and when it is, the re-created index now counts as a repair and appears in the one-shot warning, like the column repairs already do.

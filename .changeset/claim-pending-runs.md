---
'@adonis-agora/durable': minor
---

`runPending` claims a batch of pending runs in one statement and runs it concurrently. New optional `StateStore.claimPendingRuns` leases the oldest free pending runs, skipping rows another instance is claiming right now (`FOR UPDATE SKIP LOCKED`), so instances polling one backlog split it instead of racing for the same rows. The Lucid store implements it (one statement on Postgres, one transaction on MySQL, the lease's compare-and-set per run on SQLite); the in-memory store has it with `roundTripMethods`. A store without it keeps the list-then-lock loop.

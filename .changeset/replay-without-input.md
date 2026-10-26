---
"@adonis-agora/durable": patch
---

A turn no longer reads the input of every step its run has completed.

Each turn of a run starts by reading the run's checkpoints, and read every column of every row,
including the `input` of every completed step, which replaying a completed step never uses. Stores
can now implement the optional `listCheckpointsForReplay(runId)`: `listCheckpoints`, except that a
`completed` row comes back without its `input`, left out of the query. A `pending`, `running` or
`failed` row keeps it, for a re-dispatch or a retry. The engine reads a turn (and a remote
workflow's history) through it, and falls back to `listCheckpoints` on a store without it; the run
detail, `durable:runs` and `engine.listCheckpoints` still read every input. The Lucid store, the
in-memory store and `CodecStateStore` implement it: the 20th turn of a run whose steps carry
100 KB inputs read 2.2 MB on Postgres and MySQL, and now reads about 200 KB, the same as its first.

---
"@adonis-agora/durable": patch
---

A worker result settles its step without rewriting the step's `input`.

The engine wrote a settled step's whole checkpoint row again, so a step with a large input (an
agent's LLM step carries its whole prompt) had that input written twice: once when it was
dispatched, once when its result landed. Stores can now implement the optional
`settleCheckpointsIfPending(settlements)`, which writes only the columns a result changes
(`status`, `output`, `error`, `events`, `startedAt`, `finishedAt`) while the row is still `pending`,
with the same claim as `saveCheckpointsIfPending`. The engine settles every result through it, and
writes whole rows as before on a store without it. The Lucid store, the in-memory store and
`CodecStateStore` implement it: settling a step with a 100 KB input wrote about 100 KB of
checkpoint row on Postgres, MySQL and SQLite, and now writes about 40 bytes.

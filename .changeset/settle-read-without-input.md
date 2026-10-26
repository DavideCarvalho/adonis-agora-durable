---
"@adonis-agora/durable": patch
---

A worker result's settle no longer reads the step's input. It reads the step's row through the new
optional `StateStore.getCheckpointsForSettle`, `getCheckpoints` without `input`, left out of the
query itself; the engine uses it only when the store also has `settleCheckpointsIfPending`. The Lucid
and in-memory stores implement it, `CodecStateStore` decodes what it returns, and the store contract
checks it when a store has it. With the re-check by count, a turn of a conversation over 100 KB-input
steps reads about 2 KB of checkpoints where it read about 200 KB.

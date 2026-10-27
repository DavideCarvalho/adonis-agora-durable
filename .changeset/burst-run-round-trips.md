---
'@adonis-agora/durable': patch
---

A run of one step costs the Lucid store 28 statements instead of 44, which is what bounds a burst of
short jobs (2,000 runs of one step: 10.1 s → 8.2 s, 198 → 246 steps/s, on Postgres + BullMQ with two
engines and two workers).

- A write that is one statement runs without a transaction: `createRun` without search attributes,
  and `updateRun` / `updateRunIf` with a non-terminal patch (a run starting or suspending). A terminal
  settle, and anything carrying search attributes, still runs in one.
- `takeBufferedSignal` and `takeSignalWaiter` drop their transaction: the `DELETE` by id already
  decides which of two racing takers gets the row, and a token with nothing waiting (the cancel check
  on every turn, a finished run with no parent) is one `SELECT`.
- `start` of a workflow with no concurrency quota and no singleton inserts the run without reading it
  first; a duplicate id is rejected by the store and the existing run's state is returned, and a
  still-`pending` one is dispatched again, as before.
- A finished run with no parent stops reading its own run back after finding no parent waiting on it.

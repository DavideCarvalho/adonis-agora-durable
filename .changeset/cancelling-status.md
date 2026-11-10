---
"@adonis-agora/durable": major
"@adonis-agora/durable-dashboard": minor
---

A compensating cancel now persists a new run status, `cancelling`.

`engine.cancel(runId, { compensate: true })` marks the run `cancelling` before it returns, and returns that status. The run keeps it while the saga's compensations run, then becomes `cancelled`. While it is `cancelling`:

- A repeat `cancel()`, with or without `compensate`, returns `cancelling` and leaves the undo alone. Before, a second cancel without `compensate` marked the run `cancelled` and skipped the compensations still running.
- Crash recovery re-drives it on any instance, so an undo whose pod died is finished elsewhere.
- It keeps its singleton and concurrency slot, `waitForRun` keeps waiting, `engine.requeue()` returns it unchanged, and an `overlap: 'skip'` schedule doesn't fire over it.
- The dashboard and the API show it as its own status, with a filter chip.

A failed write of the cancel request now fails `cancel()` instead of being ignored, and leaves the run as it was.

**Breaking:** `RunStatus` has a new member, `cancelling`. Exhaustive `switch`es over `RunStatus` need a case for it. A custom `StateStore` must return `cancelling` runs from `listIncompleteRuns` and `listOrphanedRuns` (the new `RECOVERABLE_RUN_STATUSES` lists them, and the state-store conformance suite checks it), or recovery won't finish a crashed compensating cancel.

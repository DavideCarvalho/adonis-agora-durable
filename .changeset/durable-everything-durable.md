---
'@adonis-agora/durable': minor
---

Everything durable: every correctness-critical piece of engine state that used to live only in one
pod's memory now has a durable anchor in the store, and lease fencing keeps zombie executors from
writing over the new owner's work.

- **Lease fencing.** `StateStore.releaseRunLock` gained an optional `owner` argument (conditional,
  atomic — like `renewRunLock`); the engine releases owner-scoped everywhere, so a stale executor
  can no longer wipe the lease of the instance that took over (which could cascade into a third
  concurrent executor). A renew that reports takeover — or a `drain()` timeout release — now FENCES
  the in-flight turn: its settle degrades to a read-only echo and the new owner's writes win.
  Custom stores implemented against the old single-argument signature keep working (they just skip
  the fencing).
- **Continue-as-new is crash-safe.** The continuation run is persisted BEFORE the parent's terminal
  write (previously it only existed as an in-memory deferred start — a SIGKILL in the gap lost the
  chain forever, undetectably). The continuation also inherits the parent run's `namespace` now.
- **Child completions re-derive from the store.** If a child's terminal notify signal is lost
  (crash between the child's settle and the signal write), the parent's `ctx.child` / `ctx.all` /
  remote `startChild` re-registration reads the child's run row and synthesizes the exact
  completion the signal would have carried — instead of re-suspending forever. A cancelled child
  now surfaces to a waiting parent as a failure. `notifyParent` retries once and warns instead of
  swallowing delivery errors silently.
- **Saga compensations are checkpointed.** Each compensation owns a reserved negative checkpoint
  seq (`-2 - idx`): dispatched undos persist `pending` before dispatch and settle on the outcome,
  so a worker result consumed by ANOTHER pod (shared results queue) completes the unwind instead of
  being dropped, a re-driven unwind skips undos already done (no double refunds) and resumes the
  attempt count, and a dispatched undo with no `timeoutMs` is bounded by the new
  `compensationTimeoutMs` config (default 5 min) instead of awaiting forever.
- **Compensating cancel survives crashes and pod handoffs.** `cancel({ compensate: true })` also
  persists a durable `cancel:<runId>` marker; whichever pod next drives the run honors it, even if
  the pod that took the cancel request couldn't run the workflow.
- **Flow-control slots release cross-pod.** The admitted queue is persisted on the step's `pending`
  checkpoint (new nullable `queue` column, auto-repaired on boot), so the instance that receives
  the result frees the slot — previously an in-memory map on the dispatching pod leaked the slot
  whenever another pod completed the step, starving `concurrency: N` down to zero. A `{ queue }`
  on a `timeoutMs` step is no longer silently ignored: the same admission gate now applies.
- **Racing starts converge.** `StateStore.createRun` must reject a duplicate id (SQL stores already
  did via their primary key; the in-memory store now matches, and the conformance suite asserts
  it). The engine converges a losing `start`/`signalWithStart`/scheduler-tick race on the winner's
  run instead of surfacing a unique-constraint error (which could abort a scheduler tick or lose a
  `signalWithStart` signal).
- **`recoverIncomplete` can't resurrect a settled run.** The `running → pending` recovery flip is
  now a conditional write under the held lease, so a redelivered result that settled the run in the
  gap wins — no more clobbering `completed` back to `pending` and re-executing a finished run.
- **`sweepTimeouts` cancels properly.** An execution-timeout sweep now cascades to the child
  subtree, notifies the owning worker to abort, wakes a waiting parent, frees a singleton slot, and
  times out each run against the version it started on.
- **Small hardening.** Backoff exponents are clamped (no more `Infinity` → hot retry loop past
  ~attempt 40); liveness windows above Node's `setTimeout` max (≈24.8 days) no longer fire
  immediately; a transient store error inside `waitForRun`'s check no longer surfaces as an
  unhandled rejection.

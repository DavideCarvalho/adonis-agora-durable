---
'@adonis-agora/durable': minor
---

Re-drive a `gather_calls` step whose worker was killed mid-step, instead of orphaning it forever.

A polyglot workflow's turn declares its fan-out as `call` commands; `applyCommands` writes a
`pending` checkpoint and dispatches each one. On every later turn the worker's replay RE-EMITS the
calls it is still waiting on, and the engine skips a command whose checkpoint already exists — the
guard that stops a partially-settled fan-out from double-dispatching its live siblings.

That guard had no notion of a LOST job. A worker killed mid-step (an OOM kill) takes its in-flight
job with it, and the transport cannot always put it back: the `bullmq` transport's terminal-failure
bridge (`worker.on('failed')`) only exists inside a JS consumer, so a first-class Python fleet (see
`docs/python.mdx`) has none; the `queue` transport's stalled-claim sweep gives up past
`maxStalledCount`, and never runs at all on an adapter without `recoverStalledJobs`. Nothing then
publishes a `StepResult`, so the checkpoint stayed `pending` — "out for delivery" — and every turn
skipped it: the run woke on the `reconcileMs` sweep, dispatched a turn, had the calls re-emitted,
skipped them, and slept. Forever, with `attempts` never leaving 1 and the checkpoint's `wakeAt` NULL.

Those two tells named the gap exactly. `callRemote` (the `ctx.step` path) stamps a re-dispatch
deadline on the pending checkpoint's `wakeAt` and honours `remoteRedispatchMs`; the `call` path did
neither — so the self-heal `docs/reliability/failure-modes.mdx` documents as acting "on the
checkpoint regardless of which transport lost the job" **did not exist for a fan-out**, no matter how
it was configured.

Now the two paths share one policy, and a pending remote checkpoint's `wakeAt` means the same thing
in both: the step's LEASE.

- A settled checkpoint always wins — a step that completed just before the crash is never re-run.
- `remoteRedispatchMs` unset (still the default) keeps the by-design "re-suspend, never
  re-dispatch": a merely-slow worker is never double-run.
- Set it and the dispatched step carries a lease, and the run suspends ON it (never later than the
  `reconcileMs` sweep would have woken it anyway). Only a LAPSED lease re-dispatches, bounded by
  `remoteRedispatchMax` (default 10); past the bound the step is failed `remote_step_lost`, which
  enters the run's history so the workflow's own error path surfaces it rather than the engine
  looping.
- A step-scoped heartbeat now RENEWS that lease durably, so a worker still holding a long step keeps
  it — the in-memory rearm only ever protected a `timeoutMs` step, and only on the instance that
  dispatched it.
- Observability: a re-drive emits `step.started` with `redispatched: true` and appends a `warn`
  `step.redispatched` event to the checkpoint's own trail (`step.lost` at the bound), so "re-driven
  after a lost worker" reads differently from a failure retry — in the dashboard and in the database.

No schema change and no new config knob: `remoteRedispatchMs` / `remoteRedispatchMax` (already
carried through from `config/durable.ts`) now simply mean what they say for a fan-out too.

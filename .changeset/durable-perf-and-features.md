---
'@adonis-agora/durable': minor
---

Performance wave + new features.

**Performance** — the poll loops now push their predicates into the store instead of fetching
everything and filtering in process:

- Recovery asks for ORPHANS only (`listOrphanedRuns`: running + free/expired lease, bounded) —
  previously every worker fetched every running run once per second and issued one doomed lock-probe
  UPDATE per row. The execution-timeout sweep and the blocked-run poll each become one bounded query
  (`createdBefore` / `wakeBefore` pushdown); due-timer polls are capped per tick.
- Checkpoint saves and signal-waiter registrations are single native upserts
  (`INSERT … ON CONFLICT … DO UPDATE`) instead of a read-then-write transaction — the hottest write
  path drops from 4 round trips to 1.
- The dashboard resolves each page's `waiting` column via the indexed `listSignalWaitersByRunIds`
  instead of scanning the entire signal-waiter table per page load; new `run_id` and `created_at`
  indexes ship via the schema auto-repair.
- Picked-up runs execute with bounded parallelism (8) per tick, so one slow turn no longer
  serializes the rest; worker-health queries fan out in parallel; the BullMQ worker-descriptor
  lookup is memoized (5s TTL) and SCAN pages read via MGET.
- `deleteRun` sweeps the run's buffered `child:`/`cancel:` signals (previously an unbounded leak —
  one row per never-joined spawn, forever). Pollers add ±20% sleep jitter (thundering herd) and
  opt-in idle backoff.
- A suspension now records WHICH checkpoint seqs it waits on, and the settle re-checks them — a
  signal/result that landed mid-turn (whose resume no-oped on the held lease) re-drives immediately
  instead of waiting out the reconcile interval (or forever with `reconcileMs: 0`).

**Features**:

- **Console human-in-the-loop**: `POST /api/runs/:id/signal` (guarded to tokens the run actually
  waits on; `force` to buffer), `POST /api/runs/:id/update/:name` (validator-gated, 422 with the
  reason), `POST /api/runs/:id/tasks/:name/complete|fail` (honest delivered-vs-buffered reporting).
- **Runtime schedule control**: `engine.listSchedules()` (fire windows + effective pause state),
  `engine.setSchedulePaused(key, paused)` — fleet-wide via a `schedulePause` control-plane message,
  a runtime override that wins over the config until redeploy — and `engine.triggerSchedule(key)`
  (idempotent run-now); exposed at `GET /api/schedules` + `POST /api/schedules/:key/:action`.
- **Retention**: `retention: { completed: '30d', … }` hard-deletes terminal runs past their age (by
  last activity) as a throttled worker-tick phase; `engine.onEvict((run, checkpoints) => …)`
  archives before deletion (a throwing hook skips that run's delete).
- **Run origin attribution**: `WorkflowOptions.origin` / `register(…, { origin })` /
  `StartOptions.origin` stamp which package produced a run; filterable (`RunQuery.origin`),
  facetable, on the run summary — lighting up the console's origin sidebar.
- **Worker telemetry**: BullMQ worker heartbeats carry a `WorkerStatus` payload (concurrency,
  in-flight, RSS, CPU%, throughput/min, p95) — lighting up the console's worker cards.
- **Delayed starts**: `StartOptions.startAt` parks the run on its durable wake timer — no
  `ctx.sleep` polluting the body or its history.
- **Stalled-run pager**: `engine.onStalled(listener)` + `stalledAfter: '15m'` pages once per
  stranded episode (wake-forever suspensions, old pending remote steps with silent heartbeats).
- **Sliding-window rate limit**: `rateLimit: { …, algorithm: 'sliding' }` counts admissions over a
  rolling window (in-process and Redis-Lua backends) — no 2× burst at window boundaries, precise
  earliest-retry instants.
- **Replay-CI loop**: `node ace durable:export <runId> [--out fixture.json]` + `captureHistory` +
  `parseRunHistory` feed `assertReplayable`, so a step rename/reorder fails CI before it corrupts an
  in-flight run on deploy.
- **OpenAPI**: `GET <path>/api/openapi.json` serves the dashboard API's machine-readable contract,
  with a drift-guard spec pinning it to the route table.
- **Dashboard API filters**: `createdAfter`/`createdBefore` (epoch ms or ISO) and `origin` now push
  down server-side.

---
'@adonis-agora/durable': minor
---

The `db` transport no longer runs a step twice when a step outlives `leaseMs`. It also gains `concurrency`, `groupHealth` and a poison-task bound, as on the `queue` transport.

**Fix.** The task loop claimed up to `batchSize` (20) rows per poll, ran them one at a time, and renewed only the row it was running. The rest of the batch kept its claim-time timestamp. When an earlier step outlived `leaseMs`, an idle worker reclaimed those rows and ran them, and the first worker then ran them again and wrote a second result. One worker could also hold 20 rows while others sat idle. The results, heartbeat and control loops had the same flaw: a slow result handler let another engine take the rest of its batch. Now:

- the task loop claims only as many rows as it has free slots;
- every held claim is renewed every `leaseMs / 3`;
- a row runs only after its claim is re-checked;
- the task delete and result insert happen in one transaction, and only while `claimed_by` is still the worker's token. A worker that lost its claim drops its result and reports it to `onError`.

**New options on `transports.db()` / `DbTransport`:**

- `concurrency`: a number (default 1), `'adaptive'`, or `{ mode: 'adaptive', ... }`. It sets how many task rows a worker runs at once. One poll loop serves every handler name, so more slots add no polling. It uses the same adaptive controller as `queue` and `bullmq`.
- `resultConcurrency` (default 1): how many results the engine side settles at once.
- `idleBackoffMax` (default 4): idle task, heartbeat and control loops double their sleep up to this many poll intervals. The results loop never backs off.
- `maxStalledCount` (default 3): past this many takeovers of a lapsed claim, the row is deleted. A retryable failed result (`remote step worker failed: claim lapsed more than N times`) is published, so the engine's retry policy decides what happens next. Before, such a row was re-delivered forever.
- `workerHeartbeatIntervalMs` (default 10s) and `onError` (default `console.error`).

**Worker health.** Workers now beat `durable-worker-heartbeat:<token>:<instance>` keys carrying their `WorkerStatus` into `durable_transport_worker_keys`. `DbTransport` implements `groupHealth`, so `engine.workerHealth()`, the dashboard and Telescope report db groups. `depth` counts pending and claimed task rows.

**Schema.** `durable_transport_tasks` gets a `reclaims` column (integer, not null, default 0). `autoCreate` (on by default) and `createDurableTransportTables` add it to existing tables, so no new migration is needed. The published migration stub includes it for new apps. With `autoCreate: false`, add the column yourself. Until you do, tasks run as before, the poison bound is off, and the transport reports this once through `onError`.

**Behaviour change.** An unconfigured worker used to claim up to 20 rows per poll. It now claims one row at a time (default `concurrency: 1`). Raise `concurrency` to run steps in parallel.

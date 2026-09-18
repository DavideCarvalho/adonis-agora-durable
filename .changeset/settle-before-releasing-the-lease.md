---
'@adonis-agora/durable': patch
---

A run is no longer counted, dead-lettered or executed twice when its turn settles while the orphan sweep is looking at it.

Port of the same race fixed in the NestJS core (nestjs-durable#331), seen there as intermittently hung durable chat turns where an in-process worker answers a dispatched step in a couple of milliseconds:

- **A turn releases its lease only after its settled state is written.** `runExecution` returned `this.settleRun(...)` (and `this.parkBlocked(...)`) without awaiting it inside `try … finally { releaseRunLock }`, so the `finally` ran first: a first turn that completed, failed or parked `blocked` sat unlocked while its row still read `running`, which is what `listOrphanedRuns` returns for a crashed turn. Every settle in that block is now `return await`ed. (The suspend settle was already awaited.)
- **`recoverIncomplete` decides on the run it locked, not the one it listed.** It trusted the listed `running` status: a run that settled between the listing and `tryLockRun` got a recovery attempt counted and, past `maxRecoveryAttempts`, an unconditional `dead` written over a completed or suspended run. It now re-reads the run under the lease and releases it again unless it still reads `running`.
- **A replay re-reads a `pending` remote step before acting on it.** With `remoteRedispatchMs` set, a replay that found its step pending in its start-of-execution snapshot stamped the lease by writing `{ ...snapshot, wakeAt }` back, overwriting a result that had landed since with `pending` and parking the run on a lease an hour out. The step is now re-read from the store first; a result that has landed is replayed instead.

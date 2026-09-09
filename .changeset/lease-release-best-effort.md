---
'@adonis-agora/durable': patch
---

A failing lease release no longer escapes the turn's `finally`.

The `finally` that ends a turn releases the recovery lease — including on the failure path, where the thing that failed the run is frequently the same store the release has to talk to. A step that violates a DB constraint leaves Postgres refusing every further statement on that connection, so the release throws out of the `finally`, and in a turn driven as a background resume that surfaces as an unhandled rejection rather than a failed run.

Now swallowed and warned, by the same argument `releaseInflightLocks` already makes: a lease is a lease. It expires, and `recoverIncomplete` re-drives whatever is still held. A lost release costs one lease window of latency; an escaping one costs the diagnosis.

Found in an application whose test deliberately violates NOT NULL inside the persist transaction to prove the workflow ends in `error`. Every assertion passed and the suite still exited non-zero, with a lease UPDATE as the only clue.

---
'@adonis-agora/durable': patch
---

Singleton admission now counts holders admitted by 0.50-and-older replicas, so mixing old and new replicas over one store during a rolling upgrade no longer risks a second run for a key.

Old replicas admit by a scan (a run may run while it is among the `limit` oldest `running`/`suspended` runs of its key) and write no `durable:singleton:admitted` tag. No column tells such a holder apart from a waiter: denials (old and new) park the run `suspended` with a retry `wakeAt` and no tag, which is also what a sleeping holder looks like. So the discriminator is the old rule itself. `singletonAdmissionTags`, and so `tryAdmitSingleton` on every bundled store, also counts as holders the untagged runs inside the old scan's window (the `limit` oldest `running`/`suspended` runs, with tagged holders ranked in), never counting the candidate itself. It is read inside the same locked claim. FIFO and handover are unchanged: the oldest waiter still goes first, and the slot moves on when the old holder settles. In a fleet with no old replica left, decisions are the same as before, except when `createdAt` skew ranks a tagged holder behind `limit` untagged waiters. Those waiters then wait for that holder to settle.

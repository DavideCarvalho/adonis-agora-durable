---
'@adonis-agora/durable': patch
---

Singleton admission counts holders admitted by 0.50-and-older replicas, so mixing old and new replicas over one store during a rolling upgrade never puts a second run on a key beside an old holder — including one an old replica admitted out of order, past an older `pending` run.

A 0.51 replica now stamps the reserved `durable:singleton:tracked` tag on a singleton run's first execution (in the same write that sets it `running`, before it competes) and on every denial; admission swaps it for `durable:singleton:admitted`, and terminal settlement and requeue drop both (`withoutSingletonMarkers`). Both are stripped from user start tags. `singletonAdmissionTags` — and so `tryAdmitSingleton` on every bundled store — counts as holders the untagged `running`/`suspended` runs of the key that lack the tracked marker (an old replica executed them) or sit in the old scan's `limit`-oldest window (every tagged holder keeping its seat), never the candidate itself, inside the same locked claim. FIFO and handover are unchanged. A waiter an old replica parked may wait about one retry longer, until a new replica marks it. A custom store built on the exported helpers gets this for free; one that writes tags itself must drop both markers on a terminal status.

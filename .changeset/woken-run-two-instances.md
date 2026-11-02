---
'@adonis-agora/durable': patch
---

Stop a woken run executing on two instances. A queued wake read the run while the same instance's timer hand-off held its short claim, the hand-off released it, and `execute` trusted the read and started a turn holding no lease, so another instance locked the run and ran beside it. `execute` now proves a re-entry with an owner-scoped renewal. A claim in flight, or one begun while the renewal was out, leaves it unproved, and a turn that just locked runs without the proof.

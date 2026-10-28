---
'@adonis-agora/durable': patch
---

A fan step's worker no longer publishes a pickup heartbeat for a step that finishes within a second.
Every remote step's worker beat the moment it picked the task up, so a 40,000-step `ctx.all` fan
published 40,000 heartbeats, each delivered to every engine instance. For a fan step that beat only
stamps `lastHeartbeatAt` and feeds the lease renewal (a fan step cannot carry a `timeoutMs`), so the
engine now marks fan tasks `lazyPickupBeat` and the worker sends the beat once the step has run for
`PICKUP_BEAT_GRACE_MS` (1 s), or not at all when it settles first; a beat the handler sends itself
replaces it. Every other step still beats at pickup, and a worker that does not know the field beats
at pickup as before. A 40k fan with 12 subscribers locally: ~40,000 → ~300 publishes, Redis CPU −18%,
wall 4.7 s → 4.0 s.

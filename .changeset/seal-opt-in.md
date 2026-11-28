---
'@adonis-agora/durable': patch
---

Revert 1.2.0's sealed-by-default: messages are sent plain again unless sealing is turned on, and every process opens sealed messages.

**Why.** 1.2.0 sealed broker messages by default. A process on 1.1 or earlier cannot read a sealed message: a sealed step task reaching a 1.1 worker ran its handler with `input` `undefined`, and the result was taken as the step's. That was checked against the published 1.1.1. A rolling upgrade from 1.1 to 1.2.0 could therefore run steps with no input and silently corrupt runs.

**Now (the standard two-step rollout).**

1. Upgrade every process to 1.2.1 or later. Messages are still sent plain, so a 1.1 worker runs its tasks with their real input and a 1.1 engine reads results. A test against the published 1.1.1 proves it. Every 1.2.1 process already opens sealed messages (with the app's `APP_KEY`, or `@adonis-agora/crypto` between a tenant and its control plane) and replies in kind.
2. Turn sealing on: `messages: { seal: true }` in `config/durable.ts` (or `messages: { seal: true }` on one transport / `controlPlanes.redis`). Then, once no older job is queued, `acceptPlain: false`.

Sealing becomes the default in the next major, when every receiver understands it. `node ace agora:doctor` (`durable.messages`) warns while a transport still sends plain.

Receivers fail safe: a message carrying a seal they cannot open (another key, tampered, an unknown format or version) is refused and never read as plain, so a step handler never runs on it. The step is reported failed (retryable).

If you deployed 1.2.0, upgrade to 1.2.1. It opens what 1.2.0 sealed, so 1.2.0 and 1.2.1 processes can run side by side during the deploy. Any 1.1 process still running next to 1.2.0 should be upgraded too.

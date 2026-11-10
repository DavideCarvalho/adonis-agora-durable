---
"@adonis-agora/durable": patch
---

`engine.waitForRun` (and the blocking `Workflow.start()` built on it) now re-reads the run every 250 ms while it waits, so it resolves when the run settles on another pod even without a control plane. Set the interval with `waitForRunPollMs` in `config/durable.ts` or `{ pollMs }` on the call; `0` turns the re-read off. A `blocked` run no longer settles the default wait: the engine re-drives it once a capable worker appears, so the wait continues (bound it with `timeoutMs`).

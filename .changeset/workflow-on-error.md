---
"@adonis-agora/durable": minor
---

`onError` routes: when a run ends `failed` with an error whose `code` matches, the engine starts a handler workflow (`<runId>.onError`, input `{ runId, workflow, input, error }`) instead of failing the run, and the run settles with the handler's outcome. The run only follows its handler from then on; its body never runs again. Engine-orchestrated, so it holds for in-process and remote bodies. Declared with `static workflow = { onError: [{ code?, workflow }] }` (a code string or an error class with a `static code`), or `engine.register` / `registerRemote({ onError })`. `NonDeterminismError` now carries `code: 'non_determinism'`, which is never routed.

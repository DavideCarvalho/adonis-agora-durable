---
"@adonis-agora/durable-eslint-plugin": patch
---

Correct the checkpoint-boundary comments on `isInWorkflowBody`

Its doc block and the inline note beside the `isCheckpointedCallback` call named the
boundary as `ctx.step`/`ctx.task`. The boundary is `ctx.localStep`, `ctx.task` and
`ctx.sideEffect`; `ctx.step` is the dispatched step and deliberately is not one, which the
file already says a few lines above and which both rule suites assert. Comments only — no
rule behaviour changes.

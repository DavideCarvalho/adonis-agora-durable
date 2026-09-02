---
'@adonis-agora/durable': patch
---

Fix the assembler codegen hooks, which broke the build of every app that ran `node ace configure @adonis-agora/durable`. The configure step writes both hooks into `adonisrc.ts` by itself, and the build then died with:

```
TypeError: handler.handle is not a function
```

`@poppinss/hooks` — the runner the assembler drives its `init` hooks with — invokes a handler as `typeof handler === 'function' ? handler(...data) : handler.handle(action, ...data)`, so a non-function handler must expose `handle`. Both hooks exported `{ run }`. The same shape also mismatched the assembler's own `DefineHook` type, so a consumer's typecheck failed too.

`workflowsHook()` / `stepsHook()` and the default exports of `@adonis-agora/durable/hooks/workflows` and `/hooks/steps` are now plain functions. If you called `workflowsHook().run(...)` directly, call the returned value itself; the wiring in `adonisrc.ts` is unchanged, and it now works instead of throwing.

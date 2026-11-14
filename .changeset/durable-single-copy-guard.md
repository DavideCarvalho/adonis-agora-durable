---
'@adonis-agora/durable': patch
---

Fail at boot when two copies of `@adonis-agora/durable` are loaded in one process (for example two pnpm peer-resolution variants), naming both installs and the fix, instead of failing later with `Cannot construct "[class WorkflowEngine]" class`. `node ace agora:doctor` reports the same problem as the new `durable.single-copy` check.

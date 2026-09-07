---
'@adonis-agora/durable-eslint-plugin': minor
---

Two new rules, both on in the `recommended` preset: `rethrow-control-flow-signals` reports a `try/catch` inside a workflow body that swallows the engine's control-flow signals (suspend / continue-as-new) — a catch over awaited code must guard with `if (isWorkflowControlFlowSignal(e)) throw e` (offered as an editor suggestion) or rethrow unconditionally; `no-io-in-workflow-body` flags un-checkpointed I/O in the orchestration body — global `fetch(...)` calls and raw `engine.*` calls — which re-executes on every replay. `no-nondeterminism` also got sharper: it now catches bare `randomUUID` imports from `node:crypto` (incl. `import { randomUUID as uuid }` aliases and namespace/default imports), `process.env` reads (deploy-varying branches break replay), plain `Date()` calls, and same-file `const d = Date; d.now()` aliases.

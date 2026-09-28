---
'@adonis-agora/durable': minor
---

Retention can be **scoped**, and a tenant's runs can be **purged** through the engine — port of nestjs-durable#335.

- **`retention.policies`** (engine: `retentionPolicies`): scoped rules next to the per-status ages — each deletes terminal runs in its `statuses` that match its `scope` (`namespace(s)`, `workflow(s)`, `tag`/`tags`, search-attribute `attributes` — the new `RunScope` type) once their last activity is older than `maxAge`. Swept by the same throttled `sweepRetention`, with the same `onEvict` archival hooks and subtree cascade. A namespaced worker never sweeps another partition's scope.
- **`engine.purgeRuns(scope, { batchSize?, cancelLive?, children? })` / `engine.purgeNamespace(ns)`**: hard-delete every run a scope matches with its child subtree (children inherit `namespace`, not `tags` — they go with their root either way), in bounded batches, sweeping their buffered signals. Live runs are cancelled first (`cancelLive: false` keeps them). An empty scope is rejected.
- New exports: `RunScope`, `isNonEmptyRunScope`, `TERMINAL_RUN_STATUSES`, `TerminalRunStatus`, `ScopedRetentionPolicy`.

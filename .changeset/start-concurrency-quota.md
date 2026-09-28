---
'@adonis-agora/durable': minor
---

**Start-time concurrency quotas** — port of nestjs-durable#336. Cap how many runs sharing a key can be in flight and reject the start that would exceed it ("a tenant can have at most 8 turns executing"), without a hand-rolled count gate.

- `static workflow = { concurrency: { key: (input) => …, limit, countStatuses? } }` (also `engine.register` / `registerRemote`), or per start with `StartOptions.concurrency: { key, limit, countStatuses? }` (overrides the workflow's). The key is global, so several workflows can share one quota; `limit` may be an async function of the key; `countStatuses` narrows what occupies a slot (default: every non-terminal status).
- Over the limit `start` throws **`ConcurrencyLimitError`** (`key`, `limit`, `active`, `workflow`) and creates nothing; an idempotent re-start of an existing run id is never rejected. Quota-bearing runs carry the engine-minted tag `concurrency:<key>`.
- New optional `StateStore.countRuns(query)` — one `COUNT(*)` over the `listRuns` predicates — implemented by the Lucid and in-memory stores and `CodecStateStore`, and covered by the shared contract. The engine falls back to counting a listing for a custom store.

A soft cap under a race (count and insert are separate statements); use `singleton` for a strict, queueing per-key limit.

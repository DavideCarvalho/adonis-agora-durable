---
'@adonis-agora/durable': minor
'@adonis-agora/durable-dashboard': minor
---

**Breaking:** run listings are paged with `page`/`size` instead of `limit`/`offset`, and paging is now 1-BASED.

Every `@adonis-agora/*` library now exposes the same offset-pagination interface as `@adonis-agora/filter` (`FilterInput.page`/`.size`, resolved to its `ResolvedPagination { page, size }`): a **1-based** page number defaulting to `1`, and a page size. One query-string builder, one mental model, whether the listing behind it is a Lucid model or this engine's run store. Defaults and caps are unchanged — the dashboard listing still defaults to 50 rows and still caps at 200; only the spelling and the base moved.

The 0-based offset has not disappeared, it has become internal: `runPageWindow(query)` (newly exported) resolves a `RunQuery`'s `page`/`size` into the `{ limit, offset }` a store actually spends, and it is the one place that arithmetic lives. Custom `StateStore` implementations should call it rather than compute an offset by hand; the conformance kit asserts the resulting semantics (notably that **no `size` means no bound** — a store must not invent a default window).

What changed, concretely:

- `RunQuery.limit`/`.offset` → `RunQuery.page`/`.size`. This is also the cross-pod wire shape, so a `listRuns` gateway request between a proxy pod and a store pod carries `size` where it carried `limit` (the golden wire fixtures moved with it — polyglot SDKs asserting those bytes need the same rename).
- `GET /durable/api/runs` parses `?page=&size=` and answers `{ runs, page: { page, size, count }, statuses }`. `limit`/`offset` are now ignored like any other unknown flat param, so a stale client gets an unpaged first page rather than a `400`.
- The console's client (`durableClient.runsPage`, `RunPageOptions`, `runQueryString`) sends `page`/`size` and pages the runs list 1-based.

Deliberately NOT renamed: `GET /durable/api/runs/values` keeps `limit`/`offset`. That endpoint is filter's own group-by-count aggregation (`groupByCount[limit]`/`groupByCount[offset]`, `GroupByCountFromRequestOptions`), not a run listing — `limit`/`offset` IS the aligned spelling there, and respelling it would diverge from the lib rather than match it. The ace `durable:runs --limit` flag also keeps its name: it is a row cap with no page companion, and it maps to `size` internally.

Migration — the offset you were sending is `(page - 1) * size`:

```ts
// before
await engine.listRuns({ workflow: 'checkout', limit: 25, offset: 50 })
// after — third page of 25
await engine.listRuns({ workflow: 'checkout', page: 3, size: 25 })
```

```
# before
GET /durable/api/runs?status=failed&limit=25&offset=50
# after
GET /durable/api/runs?status=failed&page=3&size=25
```

```ts
// a store adapter's listRuns
- if (query.limit !== undefined) q.limit(query.limit)
- if (query.offset !== undefined) q.offset(query.offset)
+ const { limit, offset } = runPageWindow(query)
+ if (limit !== undefined) q.limit(limit)
+ if (offset > 0) q.offset(offset)
```

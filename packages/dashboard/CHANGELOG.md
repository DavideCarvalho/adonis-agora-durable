# @adonis-agora/durable-dashboard

## 0.7.0

### Minor Changes

- [#320](https://github.com/DavideCarvalho/adonis-agora-durable/pull/320) [`27579ca`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/27579ca668c419ac0cc67686da7e7ed2400d37f1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.all` costs O(N) for a fan of N children, sends wide fans in batches, can cap how many children run at once, and folds a settled fan into one checkpoint
  
  Previously every settled child could wake the parent, and each wake replayed the whole fan: the parent re-registered a waiter (`putSignalWaiter`), took any buffered completion (`takeBufferedSignal`) and looked up the run (`getRun`) for every child still out. In the in-memory store, a 200-child fan whose children settle one at a time went from 22 parent replays, 1,142 `putSignalWaiter`, 1,163 `takeBufferedSignal` and 1,587 `getRun` calls to 1 replay, 0, 0 and 603. A settled 1,000-child fan now leaves the parent 1 checkpoint row instead of 1,000.
  
  - **Join barrier.** A settling child no longer wakes the parent while siblings in the same fan still have waiters. The last child to settle wakes it. A failed child of a `failFast` fan still wakes it immediately.
  - **Batched dispatch.** The fan is registered 500 children at a time through the new `StateStore.registerChildWaits`, which writes the waiters and the `running` placeholders in one transaction. Its existing checkpoints are read with one prefix query instead of one lookup per child, and the first dispatch no longer looks up each child's run or buffered completion. A child that already ran to completion under its fan id is still delivered: the deferred start that finds it settled re-delivers its completion to the waiter. Sending a 1,200-child fan takes 3 store writes and 1 read from the parent.
  - **`concurrency` option.** `ctx.all(wf, inputs, { concurrency: 1000 })` keeps at most 1,000 children running. They go out in waves of `floor(concurrency / 2)`, two waves at a time (an odd limit runs one child under it), and the parent sends the next wave as soon as one settles. Wave children carry the wave in their id (`<runId>.all.<firstSeq>.w<k>.<i>`). A limit at or above the fan size keeps the unbounded ids. A non-positive or fractional limit fails the run.
  - **Folding settled fans.** Once a fan of 100+ children (or one wave of it) settles with every child successful, its per-child checkpoints are replaced, atomically, by one `fan:<child id base>` checkpoint holding the outputs in order, through the new `StateStore.compactCheckpoints`. Every later turn of the parent then loads one row for the fan instead of one per child. Replay expands the folded checkpoint back in memory; `getRunChildren`, cancel cascades, `deleteRun` and `purgeRuns` still reach every child; and runs written before the upgrade replay unchanged. A group with a failed child stays unfolded so `requeue` can retry it, and a fan under 100 children keeps per-child checkpoints for the dashboard.
  - **No waiter re-registration on replay.** A child's running placeholder is only written with or after its waiter, so neither `ctx.all` nor `ctx.child` re-puts it on replay. `requeue` (the dashboard retry) now puts the waiter itself when it turns a failed child back into a `running` placeholder. If a successful `~retry~` of that child is already buffered, `requeue` settles the checkpoint with it directly.
  - **Lost-wake re-drive.** A wake that finds the parent's lease held is dropped. If a `ctx.all` fan or wave, or a `ctx.child`, settled during such a turn, the parent re-drives itself once the turn releases the lease, instead of waiting for the `reconcileMs` sweep.
  - **Run-scoped waiter reads.** `getRunChildren` (and the cancel, delete and purge walks built on it) and `engine.listSignalWaitersByRunIds` read through `listSignalWaitersByRunIds` in batches of 500 run ids, backed by the existing `durable_signal_waiters_run_idx` index; only a store without that method scans every waiter.
  - **Dashboard.** A folded group renders as its child-run count (`150 child runs`), and a fan of folded waves is labelled `child runs ×N`, instead of the raw `fan:` checkpoint name.
  - **Telescope.** The current-state gauges and the state breakdown count through the new `engine.countRuns` (a `COUNT` on the Lucid store) instead of listing up to 10,000 runs per status and reporting the length, which capped at 10,000 and read every row. Events of a child run started by `ctx.all`, `ctx.child` or `ctx.startChild` (without a caller-chosen id) carry `parentRunId` on the diagnostics bus, so every child of one parent is one filter away. `parentRunIdOf(runId)` is exported.
  
  New optional `StateStore` methods, implemented by the Lucid and in-memory stores and forwarded by `CodecStateStore`, and covered by the conformance kit: `hasSignalWaiter(runId, tokenPrefix)`, `registerChildWaits(entries)` and `compactCheckpoints(runId, fromSeq, toSeq, into)`. A custom store without them keeps working: without `hasSignalWaiter` the parent replays once per settled child, without `registerChildWaits` the waiters and placeholders are written one by one, and without `compactCheckpoints` settled fans are not folded. No schema change: the Lucid store's `run_id` index on `durable_signal_waiters` already exists.
  
  A `failFast` fan's `parallelGroup` is now `all:<seq>:failFast` (it was `all:<seq>`), which is how the barrier knows to wake on the first failure. A `failFast` run already suspended before the upgrade is treated as `waitAll` by the barrier: it still throws its `GatherError`, but only once the whole fan has settled.

## 0.6.0

### Minor Changes

- [#301](https://github.com/DavideCarvalho/adonis-agora-durable/pull/301) [`96f9921`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/96f99219266c411820e1f1130fd4878385c6719f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

## 0.5.0

### Minor Changes

- [#140](https://github.com/DavideCarvalho/adonis-agora-durable/pull/140) [`5c57004`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/5c570047165530c6b7bbe4c868d747e4405da49d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking:** run listings are paged with `page`/`size` instead of `limit`/`offset`, and paging is now 1-BASED.
  
  Every `@adonis-agora/*` library now exposes the same offset-pagination interface as `@adonis-agora/filter` (`FilterInput.page`/`.size`, resolved to its `ResolvedPagination { page, size }`): a **1-based** page number defaulting to `1`, and a page size. One query-string builder, one mental model, whether the listing behind it is a Lucid model or this engine's run store. Defaults and caps are unchanged — the dashboard listing still defaults to 50 rows and still caps at 200; only the spelling and the base moved.
  
  The 0-based offset has not disappeared, it has become internal: `runPageWindow(query)` (newly exported) resolves a `RunQuery`'s `page`/`size` into the `{ limit, offset }` a store actually spends, and it is the one place that arithmetic lives. Custom `StateStore` implementations should call it rather than compute an offset by hand; the conformance kit asserts the resulting semantics (notably that **no `size` means no bound** — a store must not invent a default window).
  
  What changed, concretely:
  
  - `RunQuery.limit`/`.offset` → `RunQuery.page`/`.size`. This is also the cross-pod wire shape, so a `listRuns` gateway request between a proxy pod and a store pod carries `size` where it carried `limit` (the golden wire fixtures moved with it — polyglot SDKs asserting those bytes need the same rename).
  - `GET /durable/api/runs` parses `?page=&size=` and answers `{ runs, meta: { page, size, count }, statuses }`. The pagination envelope key is **`meta`** — the name AdonisJS/Lucid's own `.paginate()` uses, and where `@adonis-agora/filter`'s offset path lands, so every `@adonis-agora/*` listing spells it the same (it also spares you `body.page.page`). It replaces the previous `limit`/`offset` echo; read the window off `body.meta`. `limit`/`offset` query params are now ignored like any other unknown flat param, so a stale client gets an unpaged first page rather than a `400`.
  - The console's client (`durableClient.runsPage`, `RunPageOptions`, `runQueryString`) sends `page`/`size` and pages the runs list 1-based; `RunsPage` carries that window as `.meta`.
  
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
  // reading the window back off a /runs response
  - const { limit, offset } = body.page
  + const { page, size, count } = body.meta
  ```
  
  ```ts
  // a store adapter's listRuns
  - if (query.limit !== undefined) q.limit(query.limit)
  - if (query.offset !== undefined) q.offset(query.offset)
  + const { limit, offset } = runPageWindow(query)
  + if (limit !== undefined) q.limit(limit)
  + if (offset > 0) q.offset(offset)
  ```

## 0.4.0

### Minor Changes

- [#115](https://github.com/DavideCarvalho/adonis-agora-durable/pull/115) [`19fcf54`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/19fcf5447f5112e51a4c2c701503c691c9f23aff) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ganha o painel de compat e uma UX honesta para ações em massa. A aba `compat` no painel de workers renderiza o `GET /api/compat` (negociação de protocolo/capability por grupo, com o motivo exato de cada pod incompatível, e os runs `blocked` com suas razões — clicáveis para o detalhe); `blocked` vira status de primeira classe (chip próprio no header e badge própria, em vez de cair no genérico "no-worker"). Ações em massa passam a confirmar antes (diálogo nomeando a ação e o filtro atual), reportar o `{ matched, applied }` do servidor num toast, e avisar quando `matched` bateu o teto de 500 do servidor ("rode de novo para continuar"); em topologia `tenant`, os botões Fix & replay e Continue desabilitam com o motivo (o gateway responde 404 para ambos). Os chips de status do header viram filtro SERVER-side na listagem (contados via `/runs/values?field=status`), então a lista e o filtro do bulk nunca divergem; entra o value picker de `workflow` ao lado dos de tag/tenant/atributos, uma busca por run id no header (`GET /runs/:id`, com "no run with that id" no 404) e um menu de sessão com o link de Logout. `cancelling` sai da união de status do cliente e dos chips — o engine nunca o emite.

- [#115](https://github.com/DavideCarvalho/adonis-agora-durable/pull/115) [`19fcf54`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/19fcf5447f5112e51a4c2c701503c691c9f23aff) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console ganha a aba de Schedules e as ações human-in-the-loop no detalhe do run. A nova view `schedules` no header renderiza o `GET /api/schedules` como tabela (key, workflow, cadência — a expressão cron verbatim ou o `everyMs` humanizado —, timezone, próximo disparo relativo, e o status do run da janela atual, clicável para o detalhe), com badge de `paused` que nomeia o override de runtime quando `pausedAtRuntime`; cada linha tem Pause/Resume (`POST /schedules/:key/pause|resume`) e "Run now" (`POST /schedules/:key/trigger`, navegando direto para o run disparado). Um run `suspended` esperando algo externo ganha o painel de ação: "Deliver signal" abre um diálogo com o token pré-preenchido e payload JSON opcional (validado antes de enviar; vazio entrega `undefined`), e o 409 do servidor vira a lista `waitingOn` como tokens selecionáveis em vez de beco sem saída; um wait de update (`update:<runId>:<name>`) vira "Send update" (`POST /runs/:id/update/:name`, com a razão do 422 do validator inline) e um wait de task (`task:<runId>:<name>`) vira "Complete task"/"Fail task" (`POST /runs/:id/tasks/:name/complete|fail`). Em topologia `tenant` a aba de schedules não aparece e os verbos desabilitam com o motivo — o gateway responde 404 para todos, mesma convenção do Fix & replay. O cliente ganha `schedules`/`setSchedulePaused`/`triggerSchedule`/`signal`/`update`/`completeTask`/`failTask` e o `DurableActionError` (status + corpo estruturado das recusas), e o preview mock serve os novos endpoints.

## 0.3.0

### Minor Changes

- [#109](https://github.com/DavideCarvalho/adonis-agora-durable/pull/109) [`f1e2194`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/f1e21949fb5c1f4e1139513cc9dde4c18561fe0c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Filtros do console sobre o `@adonis-agora/filter` no estilo unificado: a listagem, os pickers e o bulk falam o envelope `filter[...]` construído com as classes do `filter-client` (`new FilterQueryBuilder()`, pickers via `.groupByCount()`), e o servidor os serve com a classe `RunFilter` (`BaseFilter<RunQueryDraft>`, um método por chave) — listagem via `applyCustomFilter`, valores via `groupByCountFromRequest` com o adapter do console. A grafia plana (`?tag=&attr=key:op:value`) continua valendo pelo mesmo pipeline; atributos viajam opacos (`filter[attr]=key:op:value`) porque as chaves são dinâmicas. Filtro estruturado recusado responde `400` em vez de alargar em silêncio. Requer `@adonis-agora/filter@0.9.0` e `@adonis-agora/filter-client@0.3.0`.

- [#109](https://github.com/DavideCarvalho/adonis-agora-durable/pull/109) [`f1e2194`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/f1e21949fb5c1f4e1139513cc9dde4c18561fe0c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Console passa a filtrar por selects com autocomplete e texto: os filtros de tag, tenant e atributos do dashboard viram value pickers — listam o que os runs realmente contêm (contados no servidor, com busca e paginação), aceitam vários valores por eixo e aceitam valor digitado. Inclui o endpoint `GET /runs/values`, filtros multi-valor em `RunQuery` (`workflows`/`tags`/`namespaces`, operador `in` nos atributos) e a enumeração `runValueFacets` nos stores Lucid e in-memory — o mesmo comportamento do console do nestjs-durable.

## 0.2.4

### Patch Changes

- [#84](https://github.com/DavideCarvalho/adonis-agora-durable/pull/84) [`5f8c6bd`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/5f8c6bd7dbd9e9afd723ce5dd0a0f29a706059b2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard: every API request 404 under a nonce CSP — fixed.
  
  The provider used to hand the SPA its mount/API base as an inline `<script>` setting
  `window.__DURABLE_BASE__`/`__DURABLE_API__`. A host with `script-src 'self' 'nonce-…'`
  (`@adonisjs/shield`'s `@nonce`, the recommended setup) drops that script silently; the SPA then fell
  back to `/durable/api`, and on any other mount path every request from a console that rendered
  perfectly well answered 404. The config now travels as a `<script type="application/json">` data
  block, which is never executed and so cannot be refused. Nothing to change on the host; the globals
  are still honoured as a fallback for tests and hand-embedding.

## 0.2.3

### Patch Changes

- [#82](https://github.com/DavideCarvalho/adonis-agora-durable/pull/82) [`fd47f0f`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/fd47f0f042f92872c5bf928efe8aaaedd3c2a604) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dashboard rebuilt on Tailwind 4, React 19 and Vite 8 — same tokens and layout; opacity
  modifiers now resolve through `color-mix` instead of the old colour-function trick.

## 0.2.2

### Patch Changes

- [#77](https://github.com/DavideCarvalho/adonis-agora-durable/pull/77) [`f69eeb7`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/f69eeb73f1b9474d9ee96cc4dbfbd03dbb77dff5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the console's run list drifting out of alignment as new runs arrive

  The run list's virtualiser cached row heights under its default key, the array index, while React
  reconciled the rows by `run.id`. The list `key` already remounts on a filter change, but the live poll
  reorders it in place — a newly started run arriving at the top pushes every existing row down an index
  with no remount at all — and a reused row is never re-measured. Each index therefore kept the height of
  whoever sat there before, putting every row offset and the scroll track's total height out by the
  difference, so rows gradually overlapped or left gaps as runs came in.

  The size and element caches are now keyed by `run.id`, so a measurement follows the row it belongs to.

- [#78](https://github.com/DavideCarvalho/adonis-agora-durable/pull/78) [`bb587ec`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/bb587ec36d9bf0742b72eb74abd653fe349dd9ea) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add TanStack Intent AI-agent skills

  Ships seven `SKILL.md` agent skills co-located with their packages and published in the npm tarballs via a new `"skills/"` entry in each package's `files` array:

  - `packages/adonis/skills/` — durable-setup, durable-workflows, durable-determinism, durable-transports-stores, durable-reliability, durable-cluster
  - `packages/dashboard/skills/` — durable-observability

  Each package also gains the `tanstack-intent` keyword and a devDependency on `@tanstack/intent`. Discovery artifacts (`_artifacts/domain_map.yaml`, `skill_spec.md`, `skill_tree.yaml`) live at the repo root, and `.github/workflows/check-skills.yml` validates skills on PRs.

## 0.2.1

### Patch Changes

- [#64](https://github.com/DavideCarvalho/adonis-agora-durable/pull/64) [`81bc949`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/81bc949c007dd691aec1a361615e629ec6925841) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix "Cancel + Undo" in the dashboard silently performing a plain cancel.

  The console sends `POST /api/runs/:id/cancel?compensate=true` on the query string with no request body, but the handler read `compensate` from the JSON body only. The flag was therefore dropped on every cancel issued from the console: the request answered `200`, the UI reported success, and **the saga compensations never ran**. An operator who clicked a button labelled "Cancel and run saga compensations (undo completed steps in reverse)" was told it worked while completed steps were left in place — a wrong answer delivered silently, which is worse than a failed request.

  `cancelRun` and `bulkAction` now read the flag from either channel. An explicit body value still wins, so every existing body-based caller behaves exactly as before and the query string is purely additive.

  The coercion is an allowlist rather than a truthiness test — `?compensate=false` and `?compensate=0` mean **no**, where `Boolean(raw)` would have read both as yes and run an undo nobody asked for. Accepted: `true`/`1`/`yes`/`on` (and a bare `?compensate`) for yes, `false`/`0`/`no`/`off` for no, case- and whitespace-insensitive. An unrecognised value is now a `400` instead of falling back to a default the caller did not choose; previously `bulk` read any non-`'true'` value as no.

  Also on the client: `durableClient.bulk(...)` accepts `compensate`, so the bulk endpoint's documented `?compensate=true` is reachable from the SPA client at all — it previously had no way to send it.

- [#63](https://github.com/DavideCarvalho/adonis-agora-durable/pull/63) [`62a44a4`](https://github.com/DavideCarvalho/adonis-agora-durable/commit/62a44a44b99c58d60fdb6d24767478e0c3cf19e5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `engines.node` as a supported RANGE again, and stop Renovate from re-pinning it.

  All three packages shipped an exact runtime string (`"node": "v22.23.2"` / `"node": "v26.7.0"`) instead of a range. `engines.node` states which runtimes a package supports, so an exact value warns on every consumer install on any other Node and fails hard under `engine-strict`. The values were rewritten by Renovate's global `rangeStrategy: "pin"`, so `renovate.json` now disables updates for the `engines` dep type — otherwise the fix is undone on the next cycle.

## 0.2.0

### Minor Changes

- [`1aace98`](https://github.com/DavideCarvalho/adonis-durable/commit/1aace980b3294c52090e7affe0233917cf0aa118) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New React SPA dashboard, with the API surface it needs

  The dashboard is now a proper `@adonis-agora/durable-dashboard` React + Vite + Tailwind SPA (run list
  with virtualization/infinite-scroll pagination, step timeline, workflow topology graph via
  `@xyflow/react`, fix-and-replay, bulk retry/cancel, breakpoint continue, live worker heartbeats), served
  by `@adonis-agora/durable`'s existing `dashboard_provider`. The original hand-rolled
  `assets/dashboard.html` stays mounted at `<path>/legacy` for backward compatibility — nothing already
  depending on it breaks.

  New backend endpoints back the SPA, mirroring `@dudousxd/nestjs-durable-dashboard`'s
  `DurableApiController`:

  - `GET  /api/workers` — full per-group worker health (every live worker's heartbeat, not just a count)
  - `GET  /api/topology` — this deployment's durable role, for the header badge
  - `POST /api/runs/:id/retry-with-input` — fix-and-replay: a fresh linked run with corrected input
  - `POST /api/runs/:id/continue` — resume a run paused at a `ctx.breakpoint()`
  - `POST /api/bulk/:action` (`retry`|`cancel`) — apply an action to every run matching the list filter
  - `GET  /api/runs/:id/stream` — SSE live-tail of one run's lifecycle events
  - `GET  /api/runs` now also filters by `namespace` and repeatable `attr=key:op:value` search-attribute
    predicates

  `dashboardAuth` gains a second, additive auth mode: alongside the existing `login` hook (Mode B —
  built-in login page), a host app can now configure a `session` hook (Mode A) that validates the host's
  OWN auth off the raw request, for an "open the console from your app" button. Either or both may be
  configured; only one is required. `DashboardAuthOptions.login` is now optional (was previously
  required) to make room for `session`-only setups — existing configs with `login` keep working
  unchanged.

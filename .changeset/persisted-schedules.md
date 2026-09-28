---
'@adonis-agora/durable': minor
---

**Persisted schedules** — port of nestjs-durable#338. Temporal-style schedules managed at runtime and stored next to the runs, alongside the code-declared `schedules` config / `static schedule`.

- `engine.schedules`: `create` / `upsert` / `get` / `list` / `pause(note?)` / `resume` / `trigger` / `delete` / `tick`. A schedule starts `workflow` with `input` on a `cron` (+ IANA `timezone`) or a fixed `every` interval, with a stable per-window `jitter`, `overlap` (`allow` / `skip` while the previous run is in flight), `catchup` (`latest` missed window once, or `skip`), `tags` (also stamped on its runs, plus `schedule:<id>`), `searchAttributes`, `priority` and `namespace`. Failed starts are recorded as `lastError`; `get`/`list` report next/last fire, last run and fire count.
- **Multi-worker safe without locks**: a window's run id is deterministic (`sched:<id>:<windowMs>`) and advancing a schedule is a compare-and-set on its `next_fire_at`.
- `persistedSchedules: true` in `config/durable.ts` makes the worker tick (`durable:work` / the embedded worker) fire due schedules — off by default.
- New `durable_schedules` table, created by `createDurableTables` (auto-schema on boot; with `autoSchema: false`, add a migration that calls `createDurableTables` again — it only creates what's missing), and five optional `StateStore` methods (`saveSchedule`, `getSchedule`, `updateSchedule` with CAS, `deleteSchedule`, `listSchedules`) implemented by the Lucid and in-memory stores; `CodecStateStore` forwards them, encoding the schedule input. Covered by the shared contract.

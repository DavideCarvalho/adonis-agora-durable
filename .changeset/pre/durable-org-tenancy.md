---
"@adonis-agora/durable": minor
"@adonis-agora/durable-dashboard": minor
---

Organizations (tenancy). With tenancy on in `@adonis-agora/context` (or `tenancy` in `config/durable.ts`), every run carries the active tenant (`tenantId`, `tenantKind`; `StartOptions.tenantId` to choose, `null` for none). Child runs, `continueAsNew`, retries, dead-letter runs and persisted schedules keep it, and a run resumed by a timer, a signal or recovery runs with its tenant active again. App-facing reads and control calls (`getRun`, `listRuns`, `cancel`, `signal`, `requeue`, `engine.schedules`, …) only reach the active tenant's runs (another tenant's run reads as missing). New `RunQuery.tenantId` / `tenantIds`, a `tenant` value axis, nullable `tenant_id` / `tenant_kind` columns on runs and schedules (added at boot, schema revision 6), optional `tenantId` / `tenantKind` on the start-run wire message (kept only when the pod's token grants `tenancy:*` or `tenancy:<id>`). Nothing changes until tenancy is turned on.

The console shows the viewer's own organization; `authorize` may return `{ allowed: true, tenants: [...] | '*' }` to grant more, with an Organization picker (`?tenant=`, switches audited) and the organization on each row. The worker-pool filter is now labelled "Namespace".

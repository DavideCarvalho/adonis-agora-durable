---
"@adonis-agora/durable": minor
---

The durable console now serves its data to coding agents on the app's dev MCP endpoint (`/mcp/agora`) when the app registers `@adonis-agora/agent/mcp_provider`. Fourteen `durable_*` tools, gated by the console's own `authorize`: reads (`durable_list_runs`, `durable_get_run`, `durable_list_fan_members`, `durable_count_runs_by`, `durable_get_health`, `durable_list_workers`, `durable_list_schedules`, `durable_get_run_event`) are listed by default and go through the console's `redact` hooks; actions (`durable_retry_run`, `durable_cancel_run`, `durable_continue_run`, `durable_signal_run`, `durable_trigger_schedule`, `durable_pause_schedule`) only when the app opts in, and are recorded by the console's `audit` hook with the actor `mcp:<caller>`. No configuration in this package.

New `anyAuthorize(...authorizers)` in `@adonis-agora/durable/dashboard`: allows a request when any of the given `authorize` forms does, e.g. a console token for MCP clients or a signed-in admin.

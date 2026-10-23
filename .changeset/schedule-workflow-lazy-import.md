---
"@adonis-agora/durable": minor
---

`config.schedules` names the workflow with a lazy import, the way the Adonis router takes controllers: `{ key: 'nightly-report', workflow: () => import('#workflows/daily_report_workflow'), cron: '0 2 * * *' }`. A workflow class or a registered name works too.

- The import is called once, when `durable:work` or the embedded worker starts, after boot. Importing the class directly into `config/durable.ts` can hang the boot, because a service the workflow imports (`db`, `logger`) waits for the boot the config is part of.
- A module without a default export, or a class without `static workflow = { name }`, stops the worker from starting instead of failing on every tick.
- `ScheduledWorkflow<LazyWorkflowImport<typeof DailyReportWorkflow>>` (with `import type`) checks `input` against the class's `run`.
- New exports: `resolveSchedules` (resolves the lazy imports and classes to registered names; `runSchedules` refuses an unresolved lazy import), `resolveSchedule`, `LazyWorkflowImport`, `ScheduleWorkflowRef`, `ScheduleInputOf`. `mergeSchedules` returns the schedules with registered names.

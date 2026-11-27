# Entities, external tasks and schedules

Long-lived state, callbacks from foreign systems, and recurring cadences — Pattern 4 of the
`durable-workflows` skill.

Entities serialize operations per key without DB locks (register from a
preload):

```ts title="start/entities.ts"
import engine from '@adonis-agora/durable/services/main'

engine.registerEntity<{ balanceCents: number }>('account', {
  initialState: () => ({ balanceCents: 0 }),
  handlers: {
    deposit: (state, amountCents: number) => {
      state.balanceCents += amountCents
      return state.balanceCents
    },
    balance: (state) => state.balanceCents,
  },
})
// drive: engine.signalEntity('account', key, 'deposit', 500)
// read:  engine.getEntityState('account', key)
// from a workflow: await ctx.callEntity('account', key, 'deposit', 500)
```

Wait on a foreign system's own callback by id (`engine.completeTask(runId, name,
result)` / `failTask` resume the run):

```ts
import type { WorkflowCtx } from '@adonis-agora/durable'
declare const ctx: WorkflowCtx, job: { id: string; src: string } // run(ctx, job)
declare const sqs: { send(message: { queueUrl: string; body: string }): Promise<void> }, queueUrl: string
type TranscodeResult = { url: string }

const result = await ctx.task<TranscodeResult>(job.id, async () => {
  await sqs.send({ queueUrl, body: JSON.stringify({ jobId: job.id, src: job.src }) })
})
```

Recurring cadences are colocated on the class (or set in `config/durable.ts`
`schedules`, which overrides by `key`); cron needs `cron-parser` installed where
the worker runs, and only the `durable:work` loop fires schedules:

```ts
import { BaseWorkflow, type WorkflowCtx } from '@adonis-agora/durable'

export default class DailyReportWorkflow extends BaseWorkflow {
  static workflow = { name: 'daily-report', version: '1' }
  static schedule = { cron: '0 2 * * *', timezone: 'America/Sao_Paulo' }
  // or: @Scheduled({ everyMs: 60_000 }) above the class
  async run(ctx: WorkflowCtx) {} // …
}
```

In `config/durable.ts`, name the workflow with a lazy import, as Adonis does for
controllers — never a direct class import, which can hang the boot (a service the
workflow imports awaits `app.booted` while the config is still loading):

```ts title="config/durable.ts"
import { defineConfig } from '@adonis-agora/durable'

export default defineConfig({
  schedules: [
    { key: 'daily-report', workflow: () => import('#workflows/daily_report_workflow'), cron: '0 2 * * *' },
  ],
})
```

Each schedule window starts exactly once across a fleet via an idempotent
time-bucket run id.

Source: `docs/authoring/entities.mdx`, `docs/authoring/external-tasks.mdx`,
`docs/authoring/scheduling.mdx`.

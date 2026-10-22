---
"@adonis-agora/durable": minor
---

`ctx.allSettled(workflow, inputs, { concurrency })`: the same fan as `ctx.all` in `waitAll` mode, resolving with one `{ status: 'fulfilled', value } | { status: 'rejected', id, error }` per input, in input order, instead of throwing a `GatherError`. A `FatalError` thrown in a dispatched step is no longer retried: it carries `retryable: false`, which the step result builders already honour.

---
"@adonis-agora/durable": patch
---

**A namespaced engine serves its namespace's steps.** With no `partition`, the db, queue and bullmq transports now consume `<name>@<namespace>` for an engine whose namespace is set (and not `default`), matching what that engine dispatches to and what nestjs-durable's `servingPartition()` does. Before, they consumed the bare `<name>`, so a namespaced engine with no `partition` never ran its own dispatched steps and its runs stayed suspended. An explicit `partition` still wins; `partition: 'default'` keeps serving the bare tokens.

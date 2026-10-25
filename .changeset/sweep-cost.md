---
"@adonis-agora/durable": patch
---

The buffered-signal sweep no longer costs one checkpoint read per buffered row, and no longer holds up the worker tick.

- Each page is decided set-based: one `getRuns` for every parent in it (a gone or finished parent's rows go without a checkpoint read), then one `getCheckpoints` by primary key per live parent, at the seqs the child ids name (`<p>.all.<first>.<i>` at `first + i`, its fold at `first`; wave `k` of a fan in waves folds at `first + k * W`; `<p>.child.<n>` at `n`). A read by name is left only for ids that name no seq, once per parent per page.
- A sweep call stops after 250 ms of wall-clock time and the next resumes where it stopped. It never runs concurrently with itself.
- The worker loop (`node ace durable:work` and the embedded worker) starts the sweep beside the tick instead of awaiting it inside, so a slow sweep does not delay the schedules, retention and stalled phases or the next `runPending`. Shutdown waits for a sweep in flight within the drain budget. A failure of the sweep is reported by the next tick.
- The write-path check of whether a child's completion needs buffering is `getRun` plus one keyed `getCheckpoints`.

On MySQL with a 40k-child parent and ~42k buffered rows, one sweep tick went from 2,012 statements to 15–20.

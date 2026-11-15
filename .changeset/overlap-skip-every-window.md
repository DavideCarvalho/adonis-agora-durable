---
'@adonis-agora/durable': patch
---

Fix `overlap: 'skip'` letting a second run start every other window. It only checked the window just before the current one, which never has a run when it was itself skipped, so a long run had a new copy started next to it every two windows. A schedule with `overlap: 'skip'` now starts no window while any earlier run of it is still in flight (pending, running, suspended, blocked or cancelling), including runs started before a restart or by another instance. `overlap: 'skip'` now also applies to `cron` schedules (it was silently ignored there), and a `backfill` under `'skip'` catches up one window at a time.

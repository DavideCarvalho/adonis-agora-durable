---
'@adonis-agora/durable-dashboard': patch
---

Fix the console's run list drifting out of alignment as new runs arrive

The run list's virtualiser cached row heights under its default key, the array index, while React
reconciled the rows by `run.id`. The list `key` already remounts on a filter change, but the live poll
reorders it in place — a newly started run arriving at the top pushes every existing row down an index
with no remount at all — and a reused row is never re-measured. Each index therefore kept the height of
whoever sat there before, putting every row offset and the scroll track's total height out by the
difference, so rows gradually overlapped or left gaps as runs came in.

The size and element caches are now keyed by `run.id`, so a measurement follows the row it belongs to.

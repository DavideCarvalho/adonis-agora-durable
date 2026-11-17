---
"@adonis-agora/durable-dashboard": minor
---

The Runs board's filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and back/forward step through it: status, workflow, tag, namespace, attribute predicates and origin sit in the hash's query (`#?status=failed&tag=vip`, `#/run/<id>?status=failed`). A value at its default is left out, so existing `#/run/<id>` links open as before, and the filters still survive a trip to Workers and back.

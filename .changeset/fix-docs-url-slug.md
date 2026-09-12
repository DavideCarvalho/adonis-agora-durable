---
"@adonis-agora/durable-eslint-plugin": patch
---

Point the rule docs URL at a page that exists

Every rule reported the docs link as `DavideCarvalho/adonis-durable/tree/main/...`. The repo
slug redirects, but `main` is not this repo's branch, so the redirect lands on a 404 — the
URL shown next to every lint error this plugin emits.

Uses `tree/HEAD` rather than naming a branch, so a rename cannot break it the same way
again. `.changeset/config.json` carried the same stale slug and is corrected with it.

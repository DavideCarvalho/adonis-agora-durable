---
"@adonis-agora/durable-dashboard": patch
"@adonis-agora/durable": patch
---

Console ORIGIN facet: the row is now hidden unless at least one run has a named (package) origin, so a plain app no longer shows a useless `all N | unknown N`. Runs with no origin are labelled `app` (the app's own workflows) instead of `unknown`, with an updated tooltip, empty-state and run-header wording. The filter kind (`{ kind: 'unknown' }`) is unchanged.

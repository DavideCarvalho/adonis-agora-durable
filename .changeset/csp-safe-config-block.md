---
"@adonis-agora/durable": patch
"@adonis-agora/durable-dashboard": patch
---

Dashboard: every API request 404 under a nonce CSP — fixed.

The provider used to hand the SPA its mount/API base as an inline `<script>` setting
`window.__DURABLE_BASE__`/`__DURABLE_API__`. A host with `script-src 'self' 'nonce-…'`
(`@adonisjs/shield`'s `@nonce`, the recommended setup) drops that script silently; the SPA then fell
back to `/durable/api`, and on any other mount path every request from a console that rendered
perfectly well answered 404. The config now travels as a `<script type="application/json">` data
block, which is never executed and so cannot be refused. Nothing to change on the host; the globals
are still honoured as a fallback for tests and hand-embedding.

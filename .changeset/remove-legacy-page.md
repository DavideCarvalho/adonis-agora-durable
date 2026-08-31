---
"@adonis-agora/durable": minor
---

Remove the `GET <path>/legacy` route and the `renderDashboard` export behind it.

`/legacy` served the console as it was before the React SPA: one self-contained page whose whole
UI was an inline `<script>`. It was kept "for an environment where the SPA bundle cannot be
served", but it could not have worked under the CSP a shield-hardened host runs
(`script-src 'self' 'nonce-…'` drops that script whole, leaving a blank page behind a live,
guarded route). The JSON API it called is unchanged — `GET /api/health` in particular stays — so
a hand-written client keeps working; only the page is gone.

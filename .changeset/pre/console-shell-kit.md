---
'@adonis-agora/durable-dashboard': minor
'@adonis-agora/durable': minor
---

Console shell: the durable console is rebuilt on the Agora console kit, the shell every `@adonis-agora` console now shares.

- Left sidebar with the brand (the console switcher), nav grouped as MONITOR (Runs, Workers) and OPERATIONS (Schedules, hidden on a tenant deployment), and a footer with the signed-in user, a theme toggle and sign-out. Below 768px the sidebar becomes a drawer.
- Topbar with the page title, the organization picker, the run-id quick open and ⌘K search across consoles.
- Workers is now its own page (pods, partitions, starved queues, protocol compatibility, blocked runs) instead of a header popover. The status chips are the Runs page toolbar.
- Light mode. The theme is remembered per console in localStorage.
- Fonts are bundled (Space Grotesk, JetBrains Mono); the page no longer loads Google Fonts.
- Every page and region has its own error boundary with a retry button, shaped skeletons and empty states.

Server: the page's data block gains `search`, `viewer` and `signOut`. The new `viewer(ctx)` config option sets the user row; without it the console reads `ctx.auth.user` when the request is already authenticated. The new `signOut` option takes a POST action path, `{ href }` or `false`; without it the console uses the sign-out an account console announces on the `agora.consoles` registry (`account.signOut`). A POST sign-out carries the request's CSRF token.

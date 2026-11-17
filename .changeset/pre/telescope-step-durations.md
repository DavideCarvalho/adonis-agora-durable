---
"@adonis-agora/durable": minor
---

Telescope's "Slowest jobs" panel can rank durable steps.

- `step.completed` / `step.failed` entries carry the step's duration as the entry's `durationMs` (the diagnostics bridge now stamps it on the envelope; the watcher falls back to the payload's), and their family names the step: `durable:step.completed:<step name>`. Other events keep `durable:<type>`.
- `durableTelescopeExtension()` registers the tagging watcher at boot (unless one is already wired), and the watcher names `durable` in Telescope's watcher list. On a control plane it is also listed as a watcher run for the tenants, so the console knows durable is reporting for each app in view (`@adonis-agora/telescope` 1.0.0-rc.31+; older versions ignore it).
- New exports from `@adonis-agora/durable/telescope`: `durableEntryFamily`, `registerAutoWatcher`.

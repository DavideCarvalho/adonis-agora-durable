---
'@adonis-agora/durable': patch
---

Fix: directory discovery of `app/workflows` and `app/steps` now finds `.ts` modules in a dev app instead of silently registering nothing. Both scanners derived the extension to import from this library's own compiled file (`import.meta.url`) rather than from the directory being scanned — resolved as `.js` from `node_modules` in a consuming app, so every `.ts` entry in `app/workflows` / `app/steps` was skipped with no warning. The extension is now derived from the scanned directory's own entries, preferring `.ts` when both a built `.js` and its `.ts` source are present (so a module is never registered twice).

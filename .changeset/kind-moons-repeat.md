---
'@adonis-agora/durable-eslint-plugin': patch
---

Report the real package version in the plugin's `meta`.

`meta.version` was frozen at `0.1.0` while the package shipped `0.2.x`. ESLint surfaces `meta.version` in `--print-config` and in bug-report output, so a stale literal misidentifies which build produced a report. The version now comes from an exported `VERSION` constant, guarded by a new `test/version.spec.ts` that compares it against `package.json` (mirroring the one in `@adonis-agora/durable`), and `scripts/sync-version-literals.mjs` keeps it in sync on release.

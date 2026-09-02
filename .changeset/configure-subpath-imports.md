---
'@adonis-agora/durable': patch
---

`node ace configure` now writes the `#workflows/*` and `#steps/*` subpath imports into the app's `package.json`.

The barrels the assembler hooks generate import each module by alias (`#workflows/foo_workflow`), the way `@adonisjs/core`'s controllers barrel uses `#controllers/*`. The difference is that `#controllers/*` ships in the app skeleton and `#workflows/*` does not — so `configure` wired up barrels that named a specifier Node cannot resolve, and the app died at boot with `ERR_PACKAGE_IMPORT_NOT_DEFINED`, after a build that reported success.

Existing apps: add these to `package.json` → `imports` (or re-run `configure`, which is now a no-op when they are already present and never overwrites an alias you point elsewhere):

```json
"#workflows/*": "./app/workflows/*.js",
"#steps/*": "./app/steps/*.js"
```

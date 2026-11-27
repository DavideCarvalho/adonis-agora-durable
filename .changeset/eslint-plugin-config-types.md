---
'@adonis-agora/durable-eslint-plugin': patch
---

Type `configs.recommended` as ESLint's `Linter.Config` instead of `Record<string, unknown>`, and type the default export as an ESLint `Plugin` too. Spreading the preset, passing it to `extends`, and registering the plugin by hand now typecheck in a typed flat config (`Linter.Config[]`, `defineConfig`). Runtime behaviour is unchanged.

---
'@adonis-agora/durable': patch
'@adonis-agora/durable-eslint-plugin': patch
---

Routine dependency refresh.

`@adonis-agora/durable`'s optional `vitest` peer now accepts `^5.0.0` too (`^3.0.0 || ^4.0.0 || ^5.0.0`). The testing kit is exercised against vitest 5 in CI and the range only widens, so nothing that resolved before stops resolving. The package's stale `zod` devDependency (`3.25.76`) is realigned with the `zod@4.5.4` it already declares — and pnpm already resolved — as a runtime dependency; no published dependency range changes.

`@adonis-agora/durable-eslint-plugin` picks up `@typescript-eslint/utils@8.69.0`.

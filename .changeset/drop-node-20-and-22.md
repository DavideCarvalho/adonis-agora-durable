---
'@adonis-agora/durable': minor
'@adonis-agora/durable-dashboard': minor
'@adonis-agora/durable-eslint-plugin': minor
---

Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

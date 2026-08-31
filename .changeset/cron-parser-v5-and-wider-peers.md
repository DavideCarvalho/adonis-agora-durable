---
'@adonis-agora/durable': minor
---

`cron-parser` v5 works, and the Redis-side peers accept their new majors

The scheduler only spoke `cron-parser` v4 (`parseExpression`), while the peer range already
promised `^4 || ^5` — installing v5 made every cron schedule throw at load. The parser shape is
now detected when the module loads: v5's `CronExpressionParser.parse`, v4's `parseExpression`,
and the ESM/CJS interop wrappers around either. A compat test loads the real v4 and v5 packages
side by side and checks they agree on fire times across timezones and six-field expressions.

Peer ranges widened, never narrowed: `@adonisjs/redis` `^9.2 || ^10`, `ioredis` `^5 || ^6`,
`bullmq` `^5 || ^6`, `vitest` `^3 || ^4` (for the `testing` subpath). The suite runs against the
new majors.

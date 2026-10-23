---
'@adonis-agora/durable': patch
---

Fix `controlPlanes.redis()` and `admissions.redis()` crashing app boot with `Cannot read properties of undefined (reading 'connection')`. Both read `@adonisjs/redis/services/main`, which is only assigned after the app has booted, while the durable provider builds them during its own boot. They now resolve the Redis manager from the container (`'redis'`), and fail with an actionable error when `@adonisjs/redis` is not registered.

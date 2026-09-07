---
'@adonis-agora/durable': minor
---

Widen the optional `@adonisjs/redis` peer to also accept `^11.0.0` (was `^9.2.0 || ^10.0.0`).

`RedisAdmissionBackend` and `RedisControlPlane` duck-type over `ioredis`/`@adonisjs/redis`'s `RedisConnection`, and the compile-time assignability check in `test/types/redis-pubsub-assignability.ts` still passes unchanged against `@adonisjs/redis@11` — its `RedisConnection`/pub-sub shape didn't change in a way that affects this package's surface. No code changes; peer ranges only ever widen.

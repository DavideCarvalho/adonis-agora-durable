---
'@adonis-agora/durable': minor
---

`RedisPubSub` can now actually be satisfied by the two clients it advertises. Its docblock claimed "BOTH a raw `ioredis` instance and an `@adonisjs/redis` connection satisfy it structurally". Against the real typings, **neither did** — passing either one to `RedisControlPlane`/`defineConfig`'s `connection` was a compile error, on an API whose own feature detection is built on the assumption that callers can:

- A real `Redis` failed on `subscribe`. The port declared `subscribe(channel, handler?)` — that is the `@adonisjs/redis` shape. ioredis's real overloads are `(...channels: (string | Buffer)[], callback?)`, where `callback` is a node-style `(err, result)` *completion* callback, not a per-message handler; the two are not structurally compatible in either direction.
- A real `RedisConnection` failed on `on`. The port declared `on?(event: string, listener)`; `@adonisjs/redis`'s is emittery-style `<Name extends keyof ConnectionEvents>(eventName, listener, options?)`, which a plain `string` event does not satisfy.

It survived because every unit test hands the driver a hand-written fake, and the one spec that used a real client cast the mismatch away at the seam.

`RedisPubSub` is now a union of the two real shapes — `IoredisPubSub | AdonisRedisPubSub` (both newly exported, along with `IoredisSubscriber`, the narrower surface of the `duplicate()`d subscriber, which cannot publish or re-duplicate). A named type guard maps the existing runtime feature test (`duplicate()` present ⇒ raw ioredis) onto the right arm, so the call sites narrow instead of casting. The three per-event `on` overloads also let the driver drop the `as never` it needed on every listener.

No runtime behaviour changed: the detection, the channel name, the payload and the watchdog are all untouched, and the suite is unmoved at 984 passing.

Marked minor rather than patch because `RedisPubSub` stops being an `interface`: a consumer writing `class MyFake implements RedisPubSub` no longer compiles (a class cannot implement a union) and must pick the arm it models. Values assignable to the old shape generally still are — this repo's own fakes needed only that one-word change.

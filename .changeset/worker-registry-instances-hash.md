---
'@adonis-agora/durable': minor
---

The BullMQ worker registry now costs one Redis write per worker instance per beat and one read per process every 30s, whatever the number of handlers. Each instance keeps one field of `<P>-workers:instances` listing every token it serves, rewritten once per 10s beat, instead of a `SET` and an `HSET` per token. Every reader in a process (dispatch routing, worker health, the fleet's announced subscriptions) shares one `HGETALL` of that hash, reused for up to 30s; a process sees its own new handlers at once, and the engine still reads fresh before it parks a run as blocked. With 85 handlers the registry went from about 36 Redis commands per second to about 6 with the defaults, and to about 0.3 with `legacyWrites: false`.

To keep a rolling deploy visible both ways, workers still write the keys 1.0.0-rc.31 and older read (the per-instance keys and the rc.31 per-token hashes), now refreshed every `workerRegistry.legacyWriteIntervalMs` (30s) and living 90s, and engines still walk the per-instance keys of older workers (`legacyScan`, which now reads 10k keys per `SCAN` call). New `workerRegistry.legacyWrites` (default `true`): set it to `false` once every process that reads the registry runs this version, then `legacyScan: false` once every worker does.

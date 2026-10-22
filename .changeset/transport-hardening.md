---
'@adonis-agora/durable': patch
---

Transport hardening found while auditing the transports against each other:

- **`bullmq`: a connection string was ignored.** `transports.bullmq({ connection: 'redis://host:port/db' })` passed validation, but the string was then spread into the ioredis/BullMQ options character by character. Every client silently connected to `127.0.0.1:6379`. A `redis://`/`rediss://` URL is now parsed into connection options (host, port, credentials, db, TLS), and a malformed URL throws at boot.
- **`eventEmitter`: a failing result handler could crash the process.** The engine's result and heartbeat handlers were called as `void handler(...)`, so a rejection (the store briefly unreachable while settling a checkpoint) became an unhandled rejection. That is fatal under Node's default, and the result was lost. Failures now go to a new `onError` option (default `console.error`). A failed result is redelivered from memory with backoff until `close()`, and a failed heartbeat is dropped.
- **`queue`: `closeTimeoutMs`.** The close drain was a hardcoded 5s. It is now the `closeTimeoutMs` option (default 5000), as on `bullmq` and `db`.

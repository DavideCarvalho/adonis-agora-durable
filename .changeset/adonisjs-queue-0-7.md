---
'@adonis-agora/durable': minor
---

Support `@adonisjs/queue` 0.7

The `@adonisjs/queue` peer range is now `^0.6.0 || ^0.7.0`. Both versions are tested.

`@adonisjs/queue` 0.7 runs on `@boringnode/queue` 0.9, which changed the adapter contract that the `queue` transport uses directly. Every claim now carries a lease token, and `completeJob`, `retryJob` and `failJob` take that lease instead of the job id. The transport used to pass the job id. On 0.7 that finished no job: Redis left the job `active` without saying anything, and the database driver threw on every call. The stalled sweep would then deliver the job again, so every step would have run twice. The transport now reads the contract from each claim. It uses the lease when there is one and the job id on 0.6. Jobs that stalled more than `maxStalledCount` times are now failed by the transport, because 0.7 gives them back to the caller instead of failing them itself.

The durable provider (and the dashboard provider's diagnostics hook) no longer build the engine when the app boots in `warmup` mode. That build opened the transport and store connections. `node ace codegen` and other warmup commands now exit instead of hanging on a queue, Redis or database connection that nothing closes. This is the same fix `@adonisjs/queue` 0.7 made for its own manager. The engine is still built on first use.

Upgrading an app to `@adonisjs/queue` 0.7:

- Stop every process on the old version first, then run `node ace queue:migrate` before you start the new ones (see the [`@adonisjs/queue` 0.7 upgrade notes](https://github.com/adonisjs/queue/releases/tag/v0.7.0)). Durable stores no schedules or dedup ids in the queue backend, so its own queues need nothing else.
- `defaultJobOptions` (`maxRetries`, `retry`, `timeout`, `failOnTimeout`) and `worker.unknownJobRetries` do not apply to durable's jobs. `queue:work` never runs them, and step retries, timeouts and backoff still come from the step options.
- Don't point `queue:work` at durable's `<prefix>:…` queues.

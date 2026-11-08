---
'@adonis-agora/durable': minor
---

BullMQ: a dispatched `ctx.step`'s result goes back to the engine instance that dispatched it, which holds the workflow body parked on the step, so with several engines the body continues instead of replaying on whichever engine took the result. The engine consumes `<P>-results-to-<instanceId>` while it keeps `<P>:reply-alive:<instanceId>` alive; a worker sends there while the key exists, else to the shared `<P>-results`. A dead engine's routed results are moved to the shared queue by the other transports' sweep, so none is lost. Step fans keep the shared results. The queue, keys and job names are the NestJS transport's and the Python worker's, so a mixed fleet routes too; engines and workers that predate it ignore the field.

New `RemoteTask.replyTo` and optional `Transport.consumeRepliesFor`. Transport options `replyRouting` (default `true`), `replyAliveTtlMs` (15 s), `replySweepMs` (5 s), `replyDrainIdleMs` (90 s). Engine option `routeReplies` (default `true` while the sticky cache is on), and `stickyRuns`, `stickyIdleMs`, `routeReplies` in `config/durable.ts`.

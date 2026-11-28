---
"@adonis-agora/durable": minor
---

Build pinned transports on demand. A step can pin any key of `transports` in `config/durable.ts` with `ctx.step(step, input, { transport })` (or `ctx.all` over a step) without listing it in `transportPool`: a transport not built at boot is built the first time a step pins it, with the treatment a pool member gets (consumer deferral in a console process, the namespace, result and heartbeat consumption, reply routing, close on shutdown, the live-group scan for convention workflows), and it joins the pool after `transport` and `transportPool`, so unpinned failover is unchanged. Concurrent first uses share one build; a failed build fails that step with its error and is retried on the next pin. A pin to a name not in `transports` still fails, now naming the configured transports.

`transportPool` keeps its meaning: transports built at boot, used for failover in order.

A step pinned to a transport built on demand records it on its `pending` checkpoint (new nullable `transport` column of `durable_step_checkpoints`, with a `(transport, status)` index; `DURABLE_SCHEMA_REVISION` is now 9 and `autoSchema` adds both at the next boot, or add a migration that calls `createDurableTables`). At boot the engine builds every transport a pending step still names, so results dispatched on it before a restart are still consumed. Custom stores opt in with the optional `StateStore.listPendingTransports`; without it, list the transport in `transportPool`. The boot log and `node ace agora:doctor` (`durable.transports`) show which transports are built at boot and which on demand. Hand-built engines get the same with the new `onDemandTransports` option and `engine.buildPendingTransports()`.

Steps from `app/steps` (and `engine.handle`) are still served only on the primary transport.

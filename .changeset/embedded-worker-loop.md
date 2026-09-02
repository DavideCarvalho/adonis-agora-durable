---
'@adonis-agora/durable': minor
---

Add an embedded worker loop: `worker: { embedded: true }` in `config/durable.ts` runs the same loop `durable:work` drives inside the web process, so an app whose only background work is a cadence ships one image and one process instead of a second idle container.

The loop starts only in the `web` environment — without that gate `node ace migration:run` would become a worker and `durable:work` would run two loops in one process. Shutdown stops and drains the loop before the transport and control plane close.

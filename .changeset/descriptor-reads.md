---
'@adonis-agora/durable': patch
---

The dispatch routing guard never parks a run `blocked` on reused worker descriptors: before parking, it reads them again, so a capable worker that joined inside the descriptor cache window gets the step. On BullMQ, concurrent descriptor reads of one token now share a single `SCAN` (the queue and db transports already did). `Transport.listWorkerDescriptors` takes an optional `{ fresh }`.

---
"@adonis-agora/durable": patch
---

`config/durable.ts` describes what the selected drivers run on under `Symbol.for('@adonis-agora/stack')`: the Lucid store (`run history`), the db transport (`queues`), the queue transport's worker-key table (`worker keys`), a bullmq transport's Redis (`queues`), and the Redis admission (`admission`) and control plane (`control plane`). The provider resolves the default Lucid connection and its client, so telescope's Architecture page shows them with no extra code.

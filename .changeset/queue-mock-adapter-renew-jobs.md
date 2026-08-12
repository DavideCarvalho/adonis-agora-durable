---
'@adonis-agora/durable': patch
---

Fix `MockAdapter` missing `renewJobs`, added to `@adonisjs/queue`'s `Adapter` interface

A recent `@adonisjs/queue` bump added a `renewJobs` method to its `Adapter` interface. The queue
transport's `MockAdapter` (used by the in-memory/testing transport) didn't implement it, which broke
structural assignability to `Adapter`. It now has the same "unsupported" stub as the adapter's other
not-yet-implemented methods.

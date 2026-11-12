---
'@adonis-agora/durable': patch
---

The db transport's `autoCreate`, the Lucid worker-key store and `createDurableTransportTables` / `dropDurableTransportTables` now create and drop the transport tables on the configured connection (`connection` / `connectionName` / `workerKeysConnection`) instead of always on the default one. The two helpers take an optional `connectionName` second argument, like `createDurableTables`.

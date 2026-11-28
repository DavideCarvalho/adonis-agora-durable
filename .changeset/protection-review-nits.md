---
'@adonis-agora/durable': patch
'@adonis-agora/durable-dashboard': patch
---

Console protection badges: the messages badge also reads in amber when a sealing transport still accepts plain messages (`acceptPlain`), the tone comes from the modes instead of the label, `encryptedAtRest.step` no longer lists heartbeat progress (the console never shows it), the OpenAPI contract documents `encryptedAtRest` and `redactedFields`, and the transport pool's `members` returns a copy.

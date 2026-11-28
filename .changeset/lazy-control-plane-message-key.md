---
"@adonis-agora/durable": patch
---

Fix the boot warning `messages: could not make sure the crypto key "durable-message-keys" exists in partition  (crypto: the token names no partition)` on a durable control plane whose `@adonis-agora/crypto` is a control plane too (the Agora Hub). Such a crypto control plane has no app of its own (partition `''`, which crypto refuses), so the key was checked in the wrong place, and turning `messages: { seal: true }` on would have failed every sealed message the same way.

- The key is no longer touched at boot. It is looked up, and created when missing, on the control plane's first key request (its first sealed message, the first sealed message it opens, or the first tenant asking for its key). With sealing off and no tenant asking, durable makes no crypto call and logs no warning. Every transport of the control plane shares the answer.
- On a crypto control plane the key lives in the partition `_durable` (the boot line says `partition _durable`). A leading `_` is never an authkit partition, so no tenant token can address it. A standalone crypto app keeps its own partition, and a crypto tenant its token's.
- If crypto still cannot give the key, that first request falls back to HKDF over the control plane's `APP_KEY` with one warning naming the reason and the command to create it. Without an `APP_KEY` either, the sealed message fails and the next request tries crypto again.

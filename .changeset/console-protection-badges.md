---
'@adonis-agora/durable': minor
'@adonis-agora/durable-dashboard': minor
---

The console shows how the app it serves protects run data.

**Header badges.** `Messages: sealed (tenant key)` / `sealed (app key)` / `sealed (crypto)` / `signed only (secret)` / `plain`, read from the sealer each broker transport (pool members included) and the control plane actually run with; several transports name the weakest mode, each one in the tooltip. `Store: encrypted (input/output)` / `encrypted (extended)` / `plain`, from a `CodecStateStore` and its `coverage`. `Redacted` while a `redact` hook is configured. Each tooltip explains the mode and links to its docs; plain broker messages read in amber.

**Run detail.** A lock on each field the store encrypts at rest ("Encrypted at rest; the console shows it decrypted"), and "hidden by redact" on each field a `redact` hook changed or removed. `GET /api/runs/:id` adds `encryptedAtRest: { run, step }`, and `redactedFields` (names only) on the run and on each step a hook changed.

**API.** `GET /api/topology` adds `protection: { messages: [{ transport, mode, acceptPlain }], store?: { codec, coverage }, redact: { run, checkpoint } }`: names and modes only, never a key, key id, secret, token or ciphertext. The federated console asks each app for its own (a new read-only `protection` console command); an app on an older version sends none and shows no badge. New: `engine.protection()`, `CodecStateStore#coverage`, `RedisControlPlane#messageSealer`, and the `AT_REST_COVERAGE` marker for a codec decorator of your own.

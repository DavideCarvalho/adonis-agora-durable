---
'@adonis-agora/durable': minor
---

Between tenant apps and their durable control plane, the control plane now owns the message keys. Tenants need nothing beyond what tenant topology already requires: no `@adonis-agora/crypto` and no grant.

- **One key per tenant partition**, derived by the control plane from its own secret. With `@adonis-agora/crypto` in the control plane's app, that secret is the HMAC key `durable-message-keys` in its partition. Crypto can be embedded in the Hub or be a separate crypto app the control plane is a tenant of. The key is created at boot when allowed; otherwise the boot line gives the create command and the grant `crypto:hmac:durable-message-keys`. Without crypto, the secret is HKDF over the control plane's `APP_KEY`, and the doctor notes it.
- **Key delivery.** A pod asks for its key with a `messageKey` run request. The request carries its tenant token and an ephemeral X25519 public key. The control plane needs `verifyTenant` and answers only for the partition the token verifies to, only to a fresh request. It returns the key sealed to that public key (ECDH-ES + HKDF-SHA256 + AES-256-GCM). The key stays in memory and never reaches the broker in clear.
- **What it covers.** All tenant ↔ control-plane messages use it, with a `kid` in every message. App A starting a workflow whose step runs on app B is re-sealed by the control plane with B's key. When the control plane rotates, the kid changes and pods ask again. Messages sealed under the previous kid still open.
- **Replaces 1.2's crypto-per-tenant path.** This replaces 1.2's `@adonis-agora/crypto` key `durable-messages` in each tenant's partition. If you turned `seal: true` on between tenants and their control plane on 1.2.x, upgrade both sides together, or turn it off during the upgrade.
- **Two apps sharing a transport directly (no control plane).** A message from the other app's `APP_KEY` is refused, and the warning names the fix: a shared `messages: { secret }` or `messages: { crypto: { cipher } }`.

Same rollout as 1.2.1. Receivers understand these messages from this version; sealing stays off until `messages: { seal: true }`.

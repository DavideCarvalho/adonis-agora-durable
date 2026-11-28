---
'@adonis-agora/durable': patch
---

Close the replay risk of the 1.3.0 message-key handshake.

- **Single use.** Every `messageKey` request carries a fresh nonce and its timestamp. The control plane remembers the pair (token, nonce), and the token itself (its JWT `jti`, else a hash) for the token's remaining lifetime. They live in a store every replica shares: Redis `SET NX PX` on `bullmq`, the worker-keys table on `db` and on `queue` with database worker keys. Other setups keep them per process, with a warning. A replayed request, or a second key request with the same token, is refused and logged once per partition as a possible replay. A pod refused this way asks again with a fresh token.
- **Over HTTPS when the pod can.** A pod that knows the control plane's URL asks for its key at `POST <url>/__durable/message-key`, with its token as a bearer, so the token never crosses the broker for this. The URL comes from `tenant.url`, or from what authkit-client knows of `urn:agora:durable`. Plain `http` is allowed only for localhost. If that route can't be used, the pod falls back to the broker and says so. The boot line and the doctor say which path is used. With shield's CSRF on, add `/__durable/message-key` to `exceptRoutes`.
- **What remains over the broker (documented).** Someone reading the broker who uses a pod's token first gets that tenant's key. The pod's own request is then refused and logged, so the attack is detected but not prevented. Short-lived tokens and the HTTPS path close it.

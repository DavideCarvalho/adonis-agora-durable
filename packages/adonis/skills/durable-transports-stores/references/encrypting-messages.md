# Encrypting messages

Source: `docs/transports/encrypting-messages.mdx`.

## Defaults

- Every broker transport on this version (`transports.bullmq`, `transports.queue`, `transports.db`) and
  `controlPlanes.redis` OPENS sealed messages (control-plane per-tenant seals need this version on
  both sides; 1.2.1+ opens the other modes).
  Sending them sealed is one switch,
  `messages: { seal: true }` in `config/durable.ts` (or per transport), off in 1.x and the default in
  the next major. Turn it on only once every process runs this version (1.2.1+ is enough for
  same-app seals; 1.2.0 sealed by default; that was reverted). `memory` / `eventEmitter` stay in-process.
- Same app: AES-256-GCM, key derived from `APP_KEY` (HKDF-SHA256, purpose
  `agora:durable:messages`). Boot line with `seal: true`: `[@adonis-agora/durable] bullmq messages: app key (auto)`;
  by default (sealing off): `bullmq messages: sent plain, sealed ones opened with app key (auto)`.
- Tenant ↔ control plane (`topology: 'tenant'` / `'control-plane'`): the CONTROL PLANE owns one key
  per tenant partition, derived from its `@adonis-agora/crypto` HMAC key `durable-message-keys`
  (crypto embedded, or a crypto app it is a tenant of; in partition `_durable` when crypto is a
  control plane too, as on the Hub; looked up and created on the FIRST key request, never at boot:
  sealing off = no crypto call, no warning) or else from its `APP_KEY` (also the fallback, with one
  warning, when crypto cannot give the key). A pod asks for its key carrying its tenant token
  and an ephemeral X25519 public key — over HTTPS (`POST <url>/__durable/message-key`) when the pod
  has `tenant.url` or authkit knows the control plane's URL, else as a `messageKey` run request over
  the broker (boot line says which); the control plane (needs `verifyTenant`) answers with the key
  sealed to it. Tenants need no crypto, no grant. Every message carries a `kid`; rotation = new kid,
  pods ask again. Key requests are single-use (nonce + timestamp, one per token while it lives,
  remembered in Redis / the DB across replicas, per process otherwise with a warning; a refused one
  is logged as a possible replay).
- Two apps sharing a transport without a control plane: explicit `messages: { secret | crypto }`
  in every process of both (a message from another APP_KEY is refused, with that hint).
- No key (no `APP_KEY`; a tenant without a token): plain, with a boot warning naming the fix when `seal: true` asked for sealing.
- A transport built without AdonisJS (`new BullMQTransport(...)`) opens sealed messages with
  `process.env.APP_KEY`, and sends them sealed with `messages: { seal: true, appKey | secret | crypto }`.

## The `messages` option

```ts
import { controlPlanes, transports } from '@adonis-agora/durable'

declare const kms: {
  encrypt(i: { key: string; plaintext: string; aad?: string }): Promise<{ ciphertext: string }>
  decrypt(i: { key: string; ciphertext: string; aad?: string }): Promise<{ plaintext: string }>
}

transports.bullmq({
  connection: { host: '127.0.0.1', port: 6379 },
  messages: { seal: true, secret: 'a-shared-secret-of-16+' },
}) // HMAC, readable
transports.queue({ messages: { seal: true, crypto: { cipher: kms, key: 'durable' } } }) // explicit key / KMS
transports.db({ messages: { crypto: false } }) // automatic mode off: plain
controlPlanes.redis({ messages: { insecure: true } }) // plain (opens sealed when it has the key)
transports.bullmq({
  connection: { host: '127.0.0.1', port: 6379 },
  messages: { seal: true, acceptPlain: false },
}) // refuse plain
```

With `seal: true`, `acceptPlain` defaults to `true` in 1.x (each plain kind logged once per process; the doctor's
`durable.messages` warns) and becomes `false` in the next major. Without `seal: true` plain is always
accepted, even with `acceptPlain: false`.

## What is sealed

Clear (and bound into the AAD): run id, seq, step id, handler name, group, attempt, priority,
task id, request id, tenant (events only), status. Sealed: step input/context, output/error/events,
heartbeat progress, workflow history and pending signals, decision commands (child starts), live
step events, start-run and run-request bodies and tenant tokens, run replies, tenant events,
control messages (their kind included). A ciphertext moved into another run, step or kind is
refused.

## Refused messages

Never retried, logged once per kind and reason (`E_DURABLE_MESSAGE_REJECTED`). A refused step task
does not run its handler and is reported failed (retryable). Anything else is dropped.

## Upgrading from 1.1

1. Upgrade every process to this version: still sends plain (a 1.1 worker keeps running its tasks with
   their real input), already opens sealed (1.2.1+ is enough for same-app seals; tenant ↔ control-plane
   seals need this version on both sides), replies in kind.
2. Turn sealing on: `messages: { seal: true }`.
3. Later, `acceptPlain: false`.

Why: a sealed step task reaching a 1.1 worker runs the handler with `input` undefined. 1.2.x
receivers fail safe: anything carrying a seal they cannot open is refused, never read as plain.
Sealed tenant ↔ control-plane traffic from 1.2.x (crypto key `durable-messages` in each tenant's
partition) does not open here: if you turned `seal: true` on between tenants and their control plane
on 1.2.x, upgrade both sides together, or turn it off during the upgrade.
NestJS / Python workers read plain only: keep sealing off (or `insecure`) on their transport.

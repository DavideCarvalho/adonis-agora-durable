# Encrypting messages

Source: `docs/transports/encrypting-messages.mdx`.

## Defaults

- Every 1.2.1+ broker transport (`transports.bullmq`, `transports.queue`, `transports.db`) and
  `controlPlanes.redis` OPENS sealed messages. Sending them sealed is one switch,
  `messages: { seal: true }` in `config/durable.ts` (or per transport), off in 1.x and the default in
  the next major. Turn it on only once every process runs 1.2.1+ (1.2.0 sealed by default; that was
  reverted). `memory` / `eventEmitter` stay in-process.
- Same app: AES-256-GCM, key derived from `APP_KEY` (HKDF-SHA256, purpose
  `agora:durable:messages`). Boot line with `seal: true`: `[@adonis-agora/durable] bullmq messages: app key (auto)`;
  by default (sealing off): `bullmq messages: sent plain, sealed ones opened with app key (auto)`.
- Tenant ↔ control plane (`topology: 'tenant'` / `'control-plane'`): `@adonis-agora/crypto`, found
  through its `agora.crypto` binding. Key `durable-messages` in the tenant's partition; the control
  plane needs crypto embedded and creates the key per tenant; a tenant's crypto client needs
  `crypto:encrypt:durable-messages` + `crypto:decrypt:durable-messages` (+ `crypto:keys:manage:…`
  to create it). The tenant's durable partition must be its crypto partition.
- No key (no `APP_KEY`, or no crypto between apps): plain, with a boot warning naming the fix when `seal: true` asked for sealing.
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

1. Upgrade every process to 1.2.1+: still sends plain (a 1.1 worker keeps running its tasks with
   their real input), already opens sealed, replies in kind.
2. Turn sealing on: `messages: { seal: true }`.
3. Later, `acceptPlain: false`.

Why: a sealed step task reaching a 1.1 worker runs the handler with `input` undefined. 1.2.x
receivers fail safe: anything carrying a seal they cannot open is refused, never read as plain.
NestJS / Python workers read plain only: keep sealing off (or `insecure`) on their transport.

---
'@adonis-agora/durable': minor
---

**Event-triggered workflows** — start a workflow when an external event fires, the sibling
of `static schedule`:

- `@OnEvent({ event })` — subscribe to an Adonis emitter event (exact name).
- `@OnDiagnostic({ lib, event? })` — subscribe to an `@adonis-agora/diagnostics` channel
  (`agora:<lib>:<event>`), exact, regex over events, or every event of a lib.
- `static on = [...]` — the colocated literal form (decorators only stamp it).
- The durable provider bridges the Adonis emitter + the diagnostics registry into the
  engine: exact triggers route through `publishEvent` (idempotent by `evt:<id>:<workflow>`),
  regex/any triggers start the workflow directly with the event payload as input.

```ts
@OnDiagnostic({ lib: 'payments', event: 'payment.succeeded' })
export class ProcessPaymentWorkflow extends BaseWorkflow {
  static workflow = { name: 'process-payment' }
  async run(ctx, input) { /* input = the payment.succeeded payload */ }
}
```
---
'@adonis-agora/durable': minor
---

An engine with no `namespace` now drives every namespace, instead of only `'default'`.

`namespace` was normalised to `'default'` at construction, so it was always a scope and never a
wildcard: every engine polled exactly one pool, and `resume` of a run from another threw
`NamespaceMismatch`. Serving several tenant pools therefore meant one control plane per pool.

Leaving `namespace` unset now makes the instance an **operator**: its poll paths (`runPending`,
`recoverIncomplete`, `resumeDueTimers`, `sweepTimeouts`, and the blocked poll) act on runs of every
namespace, and the `resume` guard does not apply to it. Setting a `namespace` scopes an instance to
one pool exactly as before, and a scoped engine still refuses a foreign run.

Routing follows the run rather than the engine, which is what makes one operator able to serve many
pools: a step now dispatches to `<name>@<run.namespace>`, with an explicit `StepDef.partition` still
winning. A child run (`ctx.child`, `ctx.startChild`, and a remote worker's `startChild` command)
inherits the **parent run's** namespace rather than the executing engine's — without that, an
operator recovering a tenant's parent would dispatch its children to the operator's own pool.

Additive for a deployment that never set `namespace`: runs are still stored in the `'default'` pool,
`undefined`/`''`/`'default'` still collapse to the bare queue token, and the wire names are
byte-identical. The one visible change there is that an operator no longer calls `useNamespace` on
its transports — not propagating is what keeps it on the bare prefix every pool's queues derive from.

---
"@adonis-agora/durable": minor
---

A workflow's `inputSchema` no longer stores its parsed value. The run stores the input as it was sent, and `run(ctx, input)` receives the schema's output, re-parsed from the stored input before every turn, replays included.

Storing the parsed value broke any schema whose output isn't plain JSON. The SQL stores keep the input in a JSON column, so a `Date` from `z.coerce.date()` came back as a string on Lucid (in production) while the in-memory store kept it a `Date` (in tests). A body calling `input.placedAt.toISOString()` passed its tests and failed in production. Re-parsing gives every turn the same value on every store.

- The schema must be deterministic (no `default(() => Date.now())`, no random ids), and changing it is a breaking change to the workflow: bump `version`. An in-flight run whose stored input no longer parses fails with a `SchemaValidationError` (`schema_validation`).
- A remote workflow's task carries the parsed input, re-parsed each turn. It travels as JSON, so coercions and defaults apply but a non-JSON value arrives as its JSON form. The run keeps the input as sent.
- `validateInput` still receives the parsed value.
- Singleton and concurrency keys are now computed from the stored input, which is the value the singleton gate re-reads when it re-checks admission.

This matches `@dudousxd/nestjs-durable`'s `@Workflow({ input })`.

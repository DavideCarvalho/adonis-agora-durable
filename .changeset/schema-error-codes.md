---
"@adonis-agora/durable": minor
---

`SchemaValidationError` now says which schema rejected the value, with the codes `@dudousxd/nestjs-durable` uses: `invalid_input` for a step's `input` schema or a workflow's `inputSchema` (at `start` and when a stored input no longer parses), `invalid_output` for a step's `output` schema. A rejected `searchAttributes` write and a direct `validateStandard` call keep `schema_validation`.

An `onError` route for `schema_validation` (or `code: SchemaValidationError`, whose `static code` is still `schema_validation`) keeps catching input and output failures when no route names `invalid_input` or `invalid_output`. Code that compares `error.code === 'schema_validation'` on a run, a checkpoint or a caught error — an alert, a test — must also accept the new codes. `validateStandard` and `validateStandardSync` take an optional fourth argument, the code.

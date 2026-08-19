---
'@adonis-agora/durable': patch
---

Restore the stub doc comments that `0.24.2` flattened.

`0.24.2` fixed `configure` throwing by removing the backticks from four stub bodies. Removal was not necessary: Tempura accepts an **escaped** backtick, and renders it to a real one. The prose is now restored verbatim and escaped instead, so the generated `config/durable.ts`, `config/durable_dashboard.ts` and both migrations come out byte-identical to what the stubs always intended — with ``` `createDurableTables` ```, ``` `lucid` ``` and the rest reading as code again in an editor tooltip.

Those comments are load-bearing: they are what explain why the migration delegates instead of carrying its own DDL, and why `static disableTransactions = true` is required rather than a preference. No behaviour changes; the generated files differ from `0.24.2` only in that comment styling.

The `{{{ … }}}` header keeps its unescaped backticks, as it must — it is evaluated as JavaScript.

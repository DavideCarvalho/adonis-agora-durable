---
'@adonis-agora/durable': patch
---

Fix `node ace configure @adonis-agora/durable` aborting without writing any files.

Adonis compiles a stub's body with Tempura, which builds it into a JavaScript template literal — so a backtick or a `${` anywhere in the body terminates that literal early and the stub throws at generation time. Four of the five published stubs carried backticks in their doc comments (the ordinary ``` `memory` ``` / ``` `lucid` ``` prose style), and `configure` throws on the first one it renders. Every published version therefore updated `adonisrc.ts` and then died with `Unexpected identifier 'transport'`, leaving the user with **no `config/durable.ts`, no `config/durable_dashboard.ts` and no migrations**.

The four stub bodies now use plain identifiers instead. Nothing in the generated output changed except that comment styling, and `make:workflow` was already unaffected. The `{{{ … }}}` header keeps its backticks: it is evaluated as JavaScript, so ``app.migrationsPath(`${new Date().getTime()}_create_durable_tables.ts`)`` is both legitimate and required there.

Two specs now guard it, both driving the real `app.stubs` pipeline that `codemods.makeUsingStub` runs: one asserts every stub renders to a non-empty file, the other that no body contains a backtick or `${`. The text assertion is deliberately scoped to the body so it never flags the header's legitimate use.

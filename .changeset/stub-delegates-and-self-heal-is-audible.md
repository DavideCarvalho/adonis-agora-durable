---
'@adonis-agora/durable': minor
---

The generated migration no longer copies the durable schema, and the schema self-heal is no longer silent.

**Do you need to do anything?** Only if you want the repair recorded in your migration history — nothing is broken today, and nothing breaks on upgrade.

- **You are on `autoSchema: true` (the default) and your app boots fine.** You may now see one new warning at boot, naming columns like `durable_step_checkpoints.last_heartbeat_at`. That is not a new fault — it is the library finally saying out loud something it has been doing silently at every boot: your database is missing columns the installed version writes, and `ensureSchema()` is adding them for you. Your data is fine and the columns are correct. To make it stop (and to stop depending on a runtime repair for your schema), add one migration:

  ```ts
  import { BaseSchema } from '@adonisjs/lucid/schema'
  import db from '@adonisjs/lucid/services/db'
  import { createDurableTables } from '@adonis-agora/durable'

  export default class extends BaseSchema {
    static disableTransactions = true
    async up() { await createDurableTables(db, this.db.connectionName) }
    async down() {} // convergence only — it did not create these tables
  }
  ```

  It is idempotent, additive-only, and a no-op where the self-heal already ran. `static disableTransactions = true` is required: the DDL runs on a connection the `Database` manager checks out itself, so on a `pool: { max: 1 }` connection the migrator's transaction would hold the only connection and the migration would hang.

- **You see no warning.** Nothing to do. Your migrations are current — the warning fires only on an applied repair, never on a schema that is already right, and never on a fresh database.

- **You are on `autoSchema: false`.** You are the case that could actually be broken, because nothing repairs your schema at boot. If your `durable_step_checkpoints` lacks `last_heartbeat_at` / `heartbeat_progress`, step heartbeats have been silently discarded (the engine's heartbeat write is fire-and-forget, so it never surfaced). Run the migration above.

**Why the change.** The migration stub reproduced the DDL that `createDurableTables` already produces, and the copy drifted twice — most recently missing `last_heartbeat_at` and `heartbeat_progress`, which `LucidStateStore.recordStepHeartbeat` writes on every beat. Fixing the stub did not help anyone who had already run `node ace configure`: their migration file is a frozen copy of the old DDL, and their app only worked because `ensureSchema()` patched the database at every boot with nothing recorded anywhere. A consumer audit found an app in exactly that state, byte-identical to the published stub, for eleven minor versions.

So the schema now lives in one place. `node ace configure @adonis-agora/durable` generates a migration that calls `createDurableTables(db, this.db.connectionName)` (with `db` from `@adonisjs/lucid/services/db`) and `dropDurableTables` in `down()`, instead of a DDL snapshot that can go stale. The trade, taken deliberately: a migration that calls the library is not a frozen snapshot, so a fresh database follows the installed version rather than the version you generated under. That is what already happened at boot via `autoSchema`, `createDurableTables` only ever adds tables and nullable/defaulted columns, and the schema belongs to the library — hand-versioning it is what drifted in the first place.

`createDurableTables(db, connectionName?, options?)` takes an optional third argument, `{ logger }`, to route the applied-repair warning into your own logger instead of `console`. Existing two-argument calls are unaffected. No exports moved and no signature broke; the DDL itself is unchanged.

Not changed on purpose: `autoSchema`'s default (the repair stays on, and apps in production depend on it), the repair itself (it warns, it does not throw), and the engine's fire-and-forget heartbeat write (a lost liveness update genuinely never harms a run).

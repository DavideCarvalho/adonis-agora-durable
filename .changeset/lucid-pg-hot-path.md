---
'@adonis-agora/durable': minor
---

Lucid store on Postgres: the statements every workflow step runs go to the `pg` connection as constant SQL instead of being rebuilt by Knex's query builder on every call (about a fifth of a busy engine's CPU). They run on the same Knex pool (a global transaction's connection inside one) and are still announced as Knex's `query` event; a connection with Lucid's `debug` on keeps the builder. New option `stores.lucid({ preparedStatements: true })` sends them as named prepared statements (off by default: PgBouncer in transaction mode before 1.21 cannot hold them).

`WorkflowSuspended`, thrown at every suspension point as control flow, no longer captures a stack trace.

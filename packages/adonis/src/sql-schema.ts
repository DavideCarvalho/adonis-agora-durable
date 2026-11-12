import { createHash } from 'node:crypto';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';

/**
 * The database schema the durable tables live in (`schema` on the store, the db transport and the
 * worker-key store). Every statement names it, so the tables can sit in their own schema while the
 * connection's default (its `search_path`, or its database on MySQL) stays the app's. Never done by
 * moving the connection's `search_path`: behind PgBouncer in transaction mode a `SET search_path`
 * leaks to other clients' sessions.
 *
 * Postgres: a schema. MySQL/MariaDB: a database. Any other dialect (SQLite) has no schemas, and a
 * `schema` there fails instead of being ignored.
 */

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SCHEMA_NAME_MAX = 63;

/** `schema` when it is a valid schema name, else throws naming `owner` (the option that set it). */
export function validateSchemaName(schema: string | undefined, owner: string): string | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema) || schema.length > SCHEMA_NAME_MAX) {
    throw new Error(
      `@adonis-agora/durable: ${owner} schema ${JSON.stringify(schema)} is not a valid schema name: use letters, digits, _ and $, starting with a letter or _, at most ${SCHEMA_NAME_MAX} characters.`,
    );
  }
  return schema;
}

/** Whether `client`'s dialect has schemas `schema` can name (Postgres schemas, MySQL databases). */
function supportsSchemas(client: QueryClientContract): boolean {
  const name = client.dialect.name;
  return name === 'postgres' || name === 'mysql';
}

/**
 * Throw when `schema` is set on a connection whose dialect has no schemas (SQLite), so the tables
 * never silently land in the default one.
 */
export function assertSchemaSupported(
  client: QueryClientContract,
  schema: string | undefined,
  owner: string,
): void {
  if (schema === undefined || supportsSchemas(client)) return;
  throw new Error(
    `@adonis-agora/durable: ${owner} sets schema "${schema}", but the ${client.dialect.name} connection${
      client.connectionName ? ` "${client.connectionName}"` : ''
    } has no schemas. Remove \`schema\`, or use a Postgres or MySQL connection.`,
  );
}

/**
 * `table` qualified with `schema` for Knex (`schema.table`, which Knex quotes part by part as
 * `"schema"."table"`), or `table` alone without one. Also right for a `??` binding in raw SQL.
 */
export function qualify(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/** Every value of `tables` qualified with `schema` (see {@link qualify}). */
export function qualifyAll<T extends Record<string, string>>(
  tables: T,
  schema: string | undefined,
): { [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(tables).map(([key, table]) => [key, qualify(schema, table)]),
  ) as { [K in keyof T]: string };
}

/** `client.schema`, scoped to `schema` when set. A fresh builder per call (Knex's is stateful). */
export function schemaBuilder(
  client: QueryClientContract,
  schema: string | undefined,
): QueryClientContract['schema'] {
  return schema ? client.schema.withSchema(schema) : client.schema;
}

/** Whether `table` exists in `schema` (the connection's current schema when unset). */
export async function hasTable(
  client: QueryClientContract,
  schema: string | undefined,
  table: string,
): Promise<boolean> {
  return schemaBuilder(client, schema).hasTable(table);
}

/**
 * Whether `table` in `schema` has `column`. Not `withSchema().hasColumn()`: Knex's MySQL `hasColumn`
 * ignores the schema and looks in the connection's database.
 */
export async function hasColumn(
  client: QueryClientContract,
  schema: string | undefined,
  table: string,
  column: string,
): Promise<boolean> {
  if (!schema) return client.schema.hasColumn(table, column);
  const rows = await client
    .query()
    .from('information_schema.columns')
    .select('column_name')
    .where('table_schema', schema)
    .andWhere('table_name', table)
    .andWhere('column_name', column)
    .limit(1);
  return rows.length > 0;
}

/**
 * The `information_schema` filter on `column` for `schema`: the configured one, else the
 * connection's current schema (`current_schema()` on Postgres, `database()` on MySQL).
 */
export function whereSchema<Q extends { where(column: string, value: string): unknown }>(
  q: Q,
  client: QueryClientContract,
  column: string,
  schema: string | undefined,
): Q {
  if (schema) {
    q.where(column, schema);
    return q;
  }
  const current = client.dialect.name === 'mysql' ? 'database()' : 'current_schema()';
  (q as unknown as { whereRaw(sql: string): unknown }).whereRaw(`${column} = ${current}`);
  return q;
}

/**
 * Create `schema` when it does not exist (`CREATE SCHEMA` on Postgres, `CREATE DATABASE` on MySQL),
 * for the boots that create the tables. Checked first, so a role without the right to create one
 * boots fine against a schema that is already there; when it is missing and cannot be created, the
 * error names the schema and the grant it needs.
 */
export async function ensureSchemaExists(
  client: QueryClientContract,
  schema: string | undefined,
): Promise<void> {
  if (!schema) return;
  if (await schemaExists(client, schema)) return;
  const isMysql = client.dialect.name === 'mysql';
  try {
    await client.rawQuery(
      isMysql ? 'create database if not exists ??' : 'create schema if not exists ??',
      [schema],
    );
  } catch (error) {
    // Another process created it first (the IF NOT EXISTS race on Postgres).
    if (await schemaExists(client, schema)) return;
    const grant = isMysql
      ? `the connection's user needs CREATE on \`${schema}\`.* (GRANT CREATE ON \`${schema}\`.* TO <user>), or create it once: CREATE DATABASE \`${schema}\``
      : `the connection's role needs CREATE on the database (GRANT CREATE ON DATABASE <database> TO <role>), or create it once: CREATE SCHEMA "${schema}"`;
    throw new Error(
      `@adonis-agora/durable: could not create the ${isMysql ? 'database' : 'schema'} "${schema}" for the durable tables: ${
        error instanceof Error ? error.message : String(error)
      }. To fix it, ${grant}.`,
    );
  }
}

/** Whether `schema` exists (a Postgres schema, a MySQL database). */
export async function schemaExists(client: QueryClientContract, schema: string): Promise<boolean> {
  const rows = await client
    .query()
    .from('information_schema.schemata')
    .select('schema_name')
    .where('schema_name', schema)
    .limit(1);
  return rows.length > 0;
}

/**
 * A lock key for `schema`: `base` without one (today's key, unchanged), else a key derived from both,
 * so two installs in two schemas of one database don't wait on each other. A positive bigint that
 * fits a JS number.
 */
export function schemaLockKey(base: number, schema: string | undefined): number {
  if (!schema) return base;
  const digest = createHash('sha256').update(`${base}:${schema}`).digest();
  return digest.readUIntBE(0, 6);
}

/**
 * A MySQL `GET_LOCK` name for `schema` under `prefix`: `prefix` + the schema, or + a hash of it when
 * that would pass MySQL's 64-character limit on lock names.
 */
export function mysqlLockName(prefix: string, schema: string): string {
  const name = `${prefix}${schema}`;
  if (name.length <= 64) return name;
  return `${prefix}${createHash('sha256')
    .update(schema)
    .digest('hex')
    .slice(0, 64 - prefix.length)}`;
}

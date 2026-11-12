import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { DURABLE_SCHEMA_META_TABLE, DURABLE_TABLES } from '../../src/stores/lucid-schema.js';
import { postgresTestSchemaPrefix } from '../../src/transports/db-helpers.js';
import { TRANSPORT_TABLES, WORKER_KEYS_TABLE } from '../../src/transports/db-schema.js';
import { backendUrl } from './backends.js';
import { makeIsolatedMysqlDb, mysqlTestDatabasePrefix } from './mysql.js';

/**
 * Databases for the `schema` option suites: the connection keeps its own default (Postgres: no
 * `searchPath`, so `public`; MySQL: the connection's database), and `schema` names ANOTHER schema
 * (a database on MySQL) the durable tables must land in. Every statement the libs issue must name it:
 * an unqualified one would hit the connection's default, where the tables do not exist.
 */
export interface SchemaDb {
  db: Database;
  /** The schema the tables go in (does not exist yet: the code under test creates it). */
  schema: string;
  /** Whether `table` exists in the connection's DEFAULT schema. */
  defaultHasTable(table: string): Promise<boolean>;
  /** Every SQL text sent on the connection since the db was made. */
  statements: string[];
  close(): Promise<void>;
}

export interface SchemaBackend {
  name: 'postgres' | 'mysql';
  make(): Promise<SchemaDb>;
}

const rand = () => Math.random().toString(36).slice(2, 10);

function capture(db: Database): string[] {
  const statements: string[] = [];
  const client = db.connection();
  for (const knex of new Set([client.getWriteClient(), client.getReadClient()])) {
    knex.on('query', (q: { sql?: string }) => {
      if (typeof q.sql === 'string') statements.push(q.sql);
    });
  }
  return statements;
}

function postgres(url: string): SchemaBackend {
  return {
    name: 'postgres',
    async make() {
      const db = new Database(
        {
          connection: 'pg',
          connections: {
            pg: { client: 'pg', connection: { connectionString: url }, pool: { min: 0, max: 3 } },
          },
        },
        new Logger({ enabled: false }),
        new Emitter(undefined as never),
      );
      // Under the run's test prefix, so the global teardown drops it if this file crashes.
      const schema = `${postgresTestSchemaPrefix()}S${process.pid}_${rand()}`;
      const statements = capture(db);
      return {
        db,
        schema,
        statements,
        defaultHasTable: (table) => db.connection().schema.hasTable(table),
        async close() {
          await db.rawQuery('drop schema if exists ?? cascade', [schema]).catch(() => {});
          await db.manager.closeAll();
        },
      };
    },
  };
}

function mysql(url: string): SchemaBackend {
  return {
    name: 'mysql',
    async make() {
      // The connection's default database (dropped on close) and another one for the tables.
      const db = await makeIsolatedMysqlDb(url);
      const schema = `${mysqlTestDatabasePrefix()}S${process.pid}_${rand()}`;
      const statements = capture(db);
      return {
        db,
        schema,
        statements,
        defaultHasTable: (table) => db.connection().schema.hasTable(table),
        async close() {
          await db.rawQuery('drop database if exists ??', [schema]).catch(() => {});
          await db.manager.closeAll();
        },
      };
    },
  };
}

/** Postgres when `DURABLE_PG_URL` is set, MySQL when `DURABLE_MYSQL_URL` is (both required in CI). */
export function schemaBackends(): SchemaBackend[] {
  const out: SchemaBackend[] = [];
  const pg = backendUrl('DURABLE_PG_URL');
  if (pg) out.push(postgres(pg));
  const my = backendUrl('DURABLE_MYSQL_URL');
  if (my) out.push(mysql(my));
  return out;
}

/** Every table the libs own. */
export const ALL_DURABLE_TABLES = [
  ...Object.values(DURABLE_TABLES),
  DURABLE_SCHEMA_META_TABLE,
  ...Object.values(TRANSPORT_TABLES),
  WORKER_KEYS_TABLE,
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The statements among `statements` that name one of the durable tables WITHOUT `schema` in front:
 * a quoted `"table"` / `` `table` `` or a bare `table` not preceded by `"schema".` / `` `schema`. ``.
 * An index name that starts with a table's name is a different identifier and does not match.
 */
export function unqualifiedStatements(statements: string[], schema: string): string[] {
  const qualified = new RegExp(`^(?:"${escapeRegExp(schema)}"|\`${escapeRegExp(schema)}\`)\\.$`);
  return statements.filter((sql) =>
    ALL_DURABLE_TABLES.some((table) => {
      const occurrence = new RegExp(`(?<![\\w$])(["\`]?)${escapeRegExp(table)}\\1(?![\\w$])`, 'g');
      for (const m of sql.matchAll(occurrence)) {
        const prefix = sql.slice(0, m.index).match(/(?:"[^"]*"|`[^`]*`)\.$/)?.[0] ?? '';
        if (!qualified.test(prefix)) return true;
      }
      return false;
    }),
  );
}

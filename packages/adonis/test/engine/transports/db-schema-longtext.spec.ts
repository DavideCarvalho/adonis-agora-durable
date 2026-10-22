import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/transports/db-schema.js';

/**
 * The db transport's payload columns (a step's input/output/error/events, the control and message
 * payloads, a worker key's value) hold free-form JSON. On MySQL a `text` column stops at 64KB, so a
 * bigger step input or output failed (strict mode) or was cut off (non-strict). They are `longtext`
 * there; Postgres and SQLite `text` has no such limit and is unchanged.
 *
 * The DDL is checked through Knex's MySQL dialect without a server (the dialect compiles SQL with no
 * connection). The in-place widening of an existing table is exercised against a real MySQL from a
 * scratch setup (see the PR notes); here, that a fresh table gets `longtext`.
 */
const requireFromLucid = createRequire(createRequire(import.meta.url).resolve('@adonisjs/lucid'));
const knex = requireFromLucid('knex') as (config: { client: string }) => {
  schema: {
    createTable(name: string, build: (t: never) => void): { toString(): string };
  };
};

const defs = (schema as { TRANSPORT_TABLE_DEFS?: Record<string, (t: never) => void> })
  .TRANSPORT_TABLE_DEFS;
const jsonColumns = (schema as { TRANSPORT_JSON_COLUMNS?: Record<string, { columns: string[] }> })
  .TRANSPORT_JSON_COLUMNS;

describe('db transport schema — JSON payload columns', () => {
  it('declares every payload column of every transport table', () => {
    expect(jsonColumns).toEqual({
      durable_transport_tasks: { columns: ['input', 'context'] },
      durable_transport_results: { columns: ['output', 'error', 'events'] },
      durable_transport_control: { columns: ['payload'], notNull: ['payload'] },
      durable_transport_messages: { columns: ['payload'], notNull: ['payload'] },
      durable_transport_worker_keys: { columns: ['value'], notNull: ['value'] },
    });
  });

  it('creates them as longtext on MySQL', () => {
    expect(defs).toBeDefined();
    const mysql = knex({ client: 'mysql2' });
    for (const [table, spec] of Object.entries(jsonColumns ?? {})) {
      const build = defs?.[table];
      expect(build, table).toBeDefined();
      const sql = mysql.schema.createTable(table, build as (t: never) => void).toString();
      for (const column of spec.columns) {
        expect(sql, `${table}.${column}`).toMatch(new RegExp(`\`${column}\` longtext`));
      }
    }
  });

  it('keeps them text on Postgres and SQLite', () => {
    for (const client of ['pg', 'better-sqlite3']) {
      const k = knex({ client });
      for (const [table, spec] of Object.entries(jsonColumns ?? {})) {
        const sql = k.schema.createTable(table, defs?.[table] as (t: never) => void).toString();
        for (const column of spec.columns) {
          expect(sql, `${client} ${table}.${column}`).toMatch(
            new RegExp(`[\`"]${column}[\`"] text`),
          );
        }
      }
    }
  });
});

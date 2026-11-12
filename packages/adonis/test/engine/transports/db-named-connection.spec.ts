import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { DbTransport } from '../../../src/transports/db.js';
import {
  createDurableTransportTables,
  dropDurableTransportTables,
  TRANSPORT_TABLES,
  WORKER_KEYS_TABLE,
} from '../../../src/transports/db-schema.js';
import { lucidWorkerKeys } from '../../../src/transports/worker-keys-db.js';

/**
 * Two independent in-memory connections: the DEFAULT ('primary') must never get a transport table;
 * everything pinned to 'secondary' creates and uses its tables there.
 */
function twoConnectionDb(): Database {
  const sqlite = () => ({
    client: 'better-sqlite3' as const,
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  return new Database(
    { connection: 'primary', connections: { primary: sqlite(), secondary: sqlite() } },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

const ALL_TABLES = [...Object.values(TRANSPORT_TABLES), WORKER_KEYS_TABLE];

async function tablesOn(db: Database, connection: string): Promise<string[]> {
  const present: string[] = [];
  for (const table of ALL_TABLES) {
    if (await db.connection(connection).schema.hasTable(table)) present.push(table);
  }
  return present;
}

describe('db transport on a named connection', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });

  it('createDurableTransportTables / dropDurableTransportTables honor connectionName', async () => {
    const db = twoConnectionDb();
    open.push(() => db.manager.closeAll());

    await createDurableTransportTables(db, 'secondary');
    expect(await tablesOn(db, 'secondary')).toEqual(ALL_TABLES);
    expect(await tablesOn(db, 'primary')).toEqual([]);

    await dropDurableTransportTables(db, 'secondary');
    expect(await tablesOn(db, 'secondary')).toEqual([]);
  });

  it('autoCreate builds the tables on the transport connection, not the default one', async () => {
    const db = twoConnectionDb();
    open.push(() => db.manager.closeAll());
    const transport = new DbTransport({ db, connectionName: 'secondary', pollIntervalMs: 5 });
    open.unshift(() => transport.close());

    await transport.dispatch({
      stepId: 's1',
      runId: 'r1',
      seq: 0,
      name: 'ext.work',
      group: 'ext.work',
      input: null,
      attempt: 1,
    } as never);

    expect(await tablesOn(db, 'secondary')).toEqual(ALL_TABLES);
    expect(await tablesOn(db, 'primary')).toEqual([]);
    const rows = await db.connection('secondary').from(TRANSPORT_TABLES.tasks).select('step_id');
    expect(rows.map((r) => r.step_id)).toEqual(['s1']);
  });

  it('lucidWorkerKeys creates its table on its connection', async () => {
    const db = twoConnectionDb();
    open.push(() => db.manager.closeAll());
    const keys = lucidWorkerKeys(db, { connectionName: 'secondary' });

    await keys.put('k', 'v', Date.now() + 60_000);

    expect(await keys.live(Date.now())).toEqual([{ key: 'k', value: 'v' }]);
    expect(await db.connection('secondary').schema.hasTable(WORKER_KEYS_TABLE)).toBe(true);
    expect(await db.connection('primary').schema.hasTable(WORKER_KEYS_TABLE)).toBe(false);
  });
});

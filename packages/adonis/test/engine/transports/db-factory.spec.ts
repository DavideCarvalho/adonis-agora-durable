import { afterEach, describe, expect, it } from 'vitest';
import type { DbTransport } from '../../../src/transports/db.js';
import { WORKER_KEYS_TABLE } from '../../../src/transports/db-schema.js';
import { transports } from '../../../src/transports/factory.js';
import { dbBackends } from '../../support/backends.js';

describe.each(dbBackends())('on $name', ({ makeTransportDb }) => {
  describe('transports.db — option passthrough', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
      // In order — the transport (unshifted first) before its database. Closing both at once let
      // the Postgres pool shut down under a poll still in flight, and the transport's close then
      // waited on a connection that never came (a 10s hook timeout on a loaded runner).
      for (const close of closers.splice(0)) await close();
    });

    it('forwards concurrency and the worker-health options to the DbTransport', async () => {
      const db = await makeTransportDb();
      closers.push(() => db.manager.closeAll());
      // structural test double for TransportContext: only `lucid.db` is resolved
      const ctx = { app: { container: { make: async () => db } } } as any;
      const transport = (await transports.db({
        concurrency: 4,
        resultConcurrency: 2,
        idleBackoffMax: 2,
        maxStalledCount: 5,
        workerHeartbeatIntervalMs: 10,
        instanceId: 'w-factory',
        pollIntervalMs: 5,
      })(ctx)) as DbTransport;
      closers.unshift(() => transport.close());
      transport.handle('ext.work', async () => 'x');
      const until = Date.now() + 2_000;
      let rows: Array<{ key: string; value: string }> = [];
      while (rows.length === 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10));
        rows = await db.connection().from(WORKER_KEYS_TABLE).select('key', 'value');
      }
      expect(rows.map((r) => r.key)).toEqual(['durable-worker-heartbeat:ext.work:w-factory']);
      expect(JSON.parse(rows[0]?.value ?? '{}').status).toMatchObject({
        concurrency: { mode: 'fixed', limit: 4 },
      });
    });

    it('forwards workerKeysCacheMs (0 = every read sees the live keys)', async () => {
      const db = await makeTransportDb();
      closers.push(() => db.manager.closeAll());
      const ctx = { app: { container: { make: async () => db } } } as any;
      const transport = (await transports.db({ workerKeysCacheMs: 0, pollIntervalMs: 5 })(
        ctx,
      )) as DbTransport;
      closers.unshift(() => transport.close());
      expect(await transport.listWorkerGroups()).toEqual([]);
      // A worker elsewhere advertises; with the default 5s cache the read above would be reused.
      await db
        .connection()
        .table(WORKER_KEYS_TABLE)
        .insert({
          key: 'durable-worker-heartbeat:ext.late:w2',
          value: JSON.stringify({ at: Date.now() }),
          expires_at: Date.now() + 60_000,
        });
      expect(await transport.listWorkerGroups()).toEqual(['ext.late']);
    });
  });
});

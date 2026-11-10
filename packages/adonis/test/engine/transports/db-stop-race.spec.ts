import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, WorkflowStepEvent } from '../../../src/interfaces.js';
import { DbTransport } from '../../../src/transports/db.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { dbBackends } from '../../support/backends.js';

/**
 * Every claiming loop of the db transport, across `stop()`: a poll that was already reading its table
 * when `stop()` was called must not hand what it then claims to a handler. During a deploy that is a
 * pod that already "stopped" picking up work it is about to be killed in the middle of. Each test parks
 * the loop's next read of its table, calls `stop()`, writes a row, then lets the read go: the handler
 * never runs, and the row is left for another consumer (unclaimed).
 */

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Builder = ReturnType<ReturnType<Database['connection']>['knexQuery']>;

/** `db`, seen through a proxy whose reads of one table can be parked until released. */
function gatedDb(db: Database) {
  let table: string | undefined;
  let parked = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated = (builder: Builder): Builder => {
    const proxy: unknown = new Proxy(builder, {
      get(target, prop) {
        if (prop === 'then') {
          const sql = target.toSQL().sql;
          if (table === undefined || !sql.startsWith('select') || !sql.includes(table)) {
            return target.then.bind(target);
          }
          parked += 1;
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            gate.then(() => target.then(ok, ko));
        }
        const value = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const out = value.apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy as Builder;
  };
  const proxied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'connection') return Reflect.get(target, prop, receiver);
      return (name?: string) => {
        const client = target.connection(name);
        return new Proxy(client, {
          get(c, p, r) {
            if (p !== 'knexQuery') return Reflect.get(c, p, r);
            return () => gated(c.knexQuery());
          },
        });
      };
    },
  });
  return {
    db: proxied,
    /** Park the next reads of `name`, and wait until one is parked. */
    async park(name: string) {
      table = name;
      await until(() => parked > 0);
      table = undefined;
    },
    release: () => release(),
  };
}

const task = (n: number): RemoteTask => ({
  runId: `run-${n}`,
  seq: 0,
  name: 'math',
  stepId: `run-${n}:0`,
  group: 'math',
  input: n,
  attempt: 1,
});

describe.each(dbBackends({ mysql: true }))(
  'db transport stop() on $name',
  ({ makeTransportDb }) => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function setup() {
      const db = await makeTransportDb();
      const gate = gatedDb(db);
      const consumer = new DbTransport({ db: gate.db, pollIntervalMs: 5, instanceId: 'consumer' });
      const producer = new DbTransport({ db, pollIntervalMs: 5, instanceId: 'producer' });
      cleanups.push(async () => {
        gate.release();
        await consumer.close();
        await producer.close();
        await db.manager.closeAll();
      });
      const unclaimed = async (table: string): Promise<number> => {
        const rows = (await db.from(table).whereNull('claimed_by').count('* as n')) as Array<{
          n: number | string;
        }>;
        return Number(rows[0]?.n);
      };
      /** Park `table`'s next read, stop the consumer, run `write`, release the read, await the stop. */
      const raceStop = async (table: string, write: () => Promise<void>) => {
        await gate.park(table);
        let stopped = false;
        const stopping = consumer.stop().then(() => {
          stopped = true;
        });
        await write();
        gate.release();
        await stopping;
        expect(stopped).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
      };
      return { db, consumer, producer, unclaimed, raceStop };
    }

    it('the task loop runs no step claimed after stop()', async () => {
      const { consumer, producer, unclaimed, raceStop } = await setup();
      let ran = 0;
      consumer.handle('math', async (input) => {
        ran += 1;
        return input;
      });
      await raceStop(TRANSPORT_TABLES.tasks, () => producer.dispatch(task(1)));
      expect(ran).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.tasks)).toBe(1);
    });

    it('the result loop settles no result claimed after stop()', async () => {
      const { db, consumer, producer, unclaimed, raceStop } = await setup();
      let settled = 0;
      consumer.onResult(async () => {
        settled += 1;
      });
      producer.handle('math', async (input) => input);
      await raceStop(TRANSPORT_TABLES.results, async () => {
        await producer.dispatch(task(2));
        // The worker runs the step and writes its result while the consumer is stopping.
        for (let i = 0; i < 500; i += 1) {
          const rows = (await db.from(TRANSPORT_TABLES.results).count('* as n')) as Array<{
            n: number | string;
          }>;
          if (Number(rows[0]?.n) > 0) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('no result was written');
      });
      expect(settled).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.results)).toBe(1);
    });

    it('the heartbeat loop delivers no beat claimed after stop()', async () => {
      const { consumer, producer, unclaimed, raceStop } = await setup();
      let beats = 0;
      consumer.onHeartbeat(async () => {
        beats += 1;
      });
      await raceStop(TRANSPORT_TABLES.heartbeats, () =>
        producer.heartbeat({ runId: 'r', seq: 0, stepId: 'r:0', group: 'math' }),
      );
      expect(beats).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.heartbeats)).toBe(1);
    });

    it('the control loop delivers no message claimed after stop()', async () => {
      const { consumer, producer, unclaimed, raceStop } = await setup();
      let received = 0;
      consumer.onControl(() => {
        received += 1;
      });
      await raceStop(TRANSPORT_TABLES.control, () =>
        producer.publishControl({ kind: 'cancel', runId: 'r' }),
      );
      expect(received).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.control)).toBe(1);
    });

    it('a message loop (step events) delivers nothing claimed after stop()', async () => {
      const { consumer, producer, unclaimed, raceStop } = await setup();
      let events = 0;
      consumer.onStepEvent(async () => {
        events += 1;
      });
      const event: WorkflowStepEvent = {
        runId: 'r',
        seq: 0,
        name: 'a',
        phase: 'running',
        startedAt: Date.now(),
      };
      await raceStop(TRANSPORT_TABLES.messages, () => producer.dispatchStepEvent(event));
      expect(events).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.messages)).toBe(1);
    });

    it('the run queue takes no run claimed after the transport stop()', async () => {
      const { consumer, producer, unclaimed, raceStop } = await setup();
      let runs = 0;
      consumer.onDispatchedRun(
        async () => {
          runs += 1;
        },
        { concurrency: 2 },
      );
      await raceStop(TRANSPORT_TABLES.messages, () => producer.dispatchRuns([{ runId: 'q1' }]));
      expect(runs).toBe(0);
      expect(await unclaimed(TRANSPORT_TABLES.messages)).toBe(1);
    });
  },
);

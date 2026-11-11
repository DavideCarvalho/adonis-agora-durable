import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from '@adonisjs/lucid/database';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DIAGNOSTICS_LISTENER_WORKFLOW, diagnosticsRunId } from '../../src/diagnostics/index.js';
import { createDurableTables, DURABLE_TABLES } from '../../src/stores/lucid-schema.js';
import { makeIsolatedPostgresDb } from '../../src/transports/db-helpers.js';
import { backendUrl, uniqueRedisPrefix } from '../support/backends.js';
import { CALLS_TABLE, type NodeConfig } from '../support/diagnostics-node-shared.js';

/**
 * `transports.durable()` across two real processes, on a real Postgres store and a real Redis
 * control plane. Each child boots the real `@adonis-agora/diagnostics` provider with
 * `default: 'durable'` (`test/support/diagnostics-node.ts`), so this also proves the module shape
 * diagnostics loads:
 *
 * - process A (`web`, `drive: false`) emits the event and never runs a delivery;
 * - process B (`worker`) runs the delivery run, and calls the listener once;
 * - a listener that throws on its first call is retried by the `handle` step and then succeeds;
 * - the same delivery handed over twice, from both processes at once, is one run and one call.
 */
const PG_URL = backendUrl('DURABLE_PG_URL');
const REDIS_URL = backendUrl('REDIS_URL');
const NODE = fileURLToPath(new URL('../support/diagnostics-node.ts', import.meta.url));
const REGISTER = fileURLToPath(
  new URL('../support/register-diagnostics-node.mjs', import.meta.url),
);
const LISTENER = 'TrackRun#handle';

interface Message {
  name: string;
  ready?: boolean;
  stopped?: boolean;
  delivered?: string;
  heard?: { type: string; runId: string };
  error?: string;
}

interface Node {
  proc: ChildProcess;
  messages: Message[];
  exited: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  cond: () => boolean | Promise<boolean>,
  label: string,
  nodes: Node[] = [],
  budgetMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await cond())) {
    const errors = nodes.flatMap((n) => n.messages.filter((m) => m.error));
    if (errors.length > 0) throw new Error(`child error: ${JSON.stringify(errors)}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

describe.skipIf(!PG_URL || !REDIS_URL)(
  'transports.durable() across two processes (Postgres + Redis)',
  () => {
    let db: Database & { schemaName: string };
    let redis: Redis;
    let web: Node;
    let worker: Node;
    const prefix = uniqueRedisPrefix('diag');

    function spawn(role: NodeConfig['role'], name: string): Node {
      const config: NodeConfig = {
        role,
        name,
        pgUrl: PG_URL as string,
        schema: db.schemaName,
        redisUrl: REDIS_URL as string,
        prefix,
      };
      const proc = fork(NODE, [], {
        execArgv: ['--import', REGISTER],
        env: { ...process.env, DIAG_NODE: JSON.stringify(config) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const messages: Message[] = [];
      proc.on('message', (m) => messages.push(m as Message));
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      return { proc, messages, exited };
    }

    async function stop(node: Node | undefined) {
      if (!node || node.proc.exitCode !== null || node.proc.signalCode !== null) return;
      node.proc.send({ stop: true });
      const done = await Promise.race([node.exited.then(() => true), sleep(15_000)]);
      if (!done) node.proc.kill('SIGKILL');
      await node.exited;
    }

    const calls = async (eventId: string) =>
      db
        .connection()
        .from(CALLS_TABLE)
        .where('event_id', eventId)
        .orderBy('id')
        .select('node', 'attempt');
    const runsOf = async (eventId: string) =>
      db
        .connection()
        .from(DURABLE_TABLES.runs)
        .where('workflow', DIAGNOSTICS_LISTENER_WORKFLOW)
        .andWhereLike('id', `diag:${eventId}:%`)
        .select('id', 'status');
    const handleStep = async (runId: string) =>
      db
        .connection()
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', runId)
        .andWhere('name', 'handle')
        .first();

    /** The event id the web process stamped on the event it just emitted (from its own run row). */
    async function emitted(payload: Record<string, unknown>): Promise<string> {
      const before = new Set(
        (
          await db
            .connection()
            .from(DURABLE_TABLES.runs)
            .where('workflow', DIAGNOSTICS_LISTENER_WORKFLOW)
            .select('id')
        ).map((r: { id: string }) => r.id),
      );
      web.proc.send({ emit: payload });
      let found: string | undefined;
      await until(
        async () => {
          const rows = await db
            .connection()
            .from(DURABLE_TABLES.runs)
            .where('workflow', DIAGNOSTICS_LISTENER_WORKFLOW)
            .select('id');
          found = rows.map((r: { id: string }) => r.id).find((id: string) => !before.has(id));
          return found !== undefined;
        },
        'the delivery run',
        [web, worker],
      );
      // diag:<event id>:<listener id>
      return (found as string).slice('diag:'.length, -(LISTENER.length + 1));
    }

    beforeAll(async () => {
      db = await makeIsolatedPostgresDb(PG_URL as string);
      await createDurableTables(db);
      await db.connection().schema.createTable(CALLS_TABLE, (t) => {
        t.increments('id');
        t.string('event_id').notNullable();
        t.string('node').notNullable();
        t.integer('attempt').notNullable();
      });
      redis = new Redis(REDIS_URL as string);
      web = spawn('web', 'A');
      worker = spawn('worker', 'B');
      await until(
        () => web.messages.some((m) => m.ready) && worker.messages.some((m) => m.ready),
        'both processes ready',
        [web, worker],
        60_000,
      );
      // Both control planes are subscribed before anything is published.
      await until(async () => {
        const [, n] = (await redis.pubsub('NUMSUB', `${prefix}-control`)) as [string, number];
        return Number(n) >= 2;
      }, 'both control planes subscribed');
    }, 90_000);

    afterEach(() => {
      for (const node of [web, worker]) {
        const errors = node.messages.filter((m) => m.error);
        expect(errors, `errors reported by ${node.messages[0]?.name ?? '?'}`).toEqual([]);
      }
    });

    afterAll(async () => {
      await Promise.all([stop(web), stop(worker)]);
      redis?.disconnect();
      await db?.manager.closeAll();
    }, 60_000);

    it('an event emitted in A runs its listener once, in B, as a durable run', async () => {
      const eventId = await emitted({ ok: true });
      const runId = diagnosticsRunId(eventId, LISTENER);
      await until(
        async () => (await runsOf(eventId))[0]?.status === 'completed',
        'the run to complete',
        [web, worker],
      );
      await sleep(300); // a would-be second call lands well within this
      expect(await runsOf(eventId)).toEqual([{ id: runId, status: 'completed' }]);
      expect(await calls(eventId)).toEqual([{ node: 'B', attempt: 1 }]);
      // A heard B finish it, over the Redis control plane.
      await until(
        () =>
          web.messages.some((m) => m.heard?.runId === runId && m.heard.type === 'run.completed'),
        'A to hear run.completed',
        [web, worker],
      );
    });

    it('a listener that throws on its first call is retried by the step, then succeeds', async () => {
      const eventId = await emitted({ failFirst: true });
      const runId = diagnosticsRunId(eventId, LISTENER);
      await until(
        async () => (await runsOf(eventId))[0]?.status === 'completed',
        'the run to complete',
        [web, worker],
      );
      expect(await calls(eventId)).toEqual([
        { node: 'B', attempt: 1 },
        { node: 'B', attempt: 2 },
      ]);
      expect(await handleStep(runId)).toMatchObject({ status: 'completed', attempts: 2 });
    });

    it('the same event delivered twice, from both processes, is one run and one call', async () => {
      const eventId = randomUUID();
      const delivery = {
        listenerId: LISTENER,
        envelope: {
          v: 1,
          id: eventId,
          ts: Date.now(),
          lib: 'agent',
          event: 'run.finished',
          payload: { ok: true },
        },
      };
      web.proc.send({ deliver: delivery });
      worker.proc.send({ deliver: delivery });
      web.proc.send({ deliver: delivery });
      await until(
        () =>
          web.messages.filter((m) => m.delivered).length >= 2 &&
          worker.messages.some((m) => m.delivered),
        'every hand-over to resolve',
        [web, worker],
      );
      await until(
        async () => (await runsOf(eventId))[0]?.status === 'completed',
        'the run to complete',
        [web, worker],
      );
      await sleep(300);
      expect(await runsOf(eventId)).toEqual([
        { id: diagnosticsRunId(eventId, LISTENER), status: 'completed' },
      ]);
      expect(await calls(eventId)).toEqual([{ node: 'B', attempt: 1 }]);
    });
  },
);

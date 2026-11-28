import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Database } from '@adonisjs/lucid/database';
import type { AdapterFactory } from '@adonisjs/queue/types';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/redis-control-plane.js';
import type {
  ControlMessage,
  Heartbeat,
  RemoteTask,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  TenantEvent,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../src/interfaces.js';
import type { TransportMessagesOptions } from '../../src/messages/resolve.js';
import { sanitizeQueueToken } from '../../src/tenant-group.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { DbTransport } from '../../src/transports/db.js';
import { TRANSPORT_TABLES } from '../../src/transports/db-schema.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MemoryWorkerKeys } from '../../src/transports/worker-keys.js';
import { backendUrl, dbBackends } from '../support/backends.js';

/**
 * Every message kind, sealed end to end on every transport (BullMQ on Redis, `@adonisjs/queue` on its
 * Redis adapter, the db transport on SQLite / Postgres / MySQL), and the broker's raw data inspected:
 * no input, output, progress, history, signal payload, token or event of a run appears in clear.
 */

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const APP_KEY = 'sealed-transports-app-key-0123456789';
const OTHER_KEY = 'some-other-app-key-0123456789abcdef';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

/** The transport surface these tests drive (every broker transport has it). */
type Wire = BullMQTransport | QueueTransport | DbTransport;

interface Pair {
  /** Engine / control-plane side. */
  make(messages: TransportMessagesOptions, instanceId: string): Promise<Wire>;
  /** Everything the backend holds (and, for pub/sub, everything published), as text. */
  dump(): Promise<string>;
  /** Control messages: publish on `a`, receive on `b` (the control plane for BullMQ). */
  control?(messages: TransportMessagesOptions): Promise<{
    publish(msg: ControlMessage): Promise<void>;
    receive(handler: (msg: ControlMessage) => void): void;
  }>;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

function secrets() {
  const id = randomUUID().slice(0, 8);
  const s = (label: string) => `${label}-secret-${id}`;
  return {
    input: s('input'),
    context: s('context'),
    output: s('output'),
    progress: s('progress'),
    history: s('history'),
    signal: s('signal'),
    child: s('child'),
    stepEvent: s('stepevent'),
    startInput: s('startinput'),
    token: s('tenanttoken'),
    signalPayload: s('signalpayload'),
    reply: s('reply'),
    event: s('event'),
    control: s('control'),
  };
}

/** Drive every message kind across `pair`; returns what each side received. */
async function exchange(pair: Pair, S: ReturnType<typeof secrets>) {
  const sealed = { appKey: APP_KEY, seal: true };
  const a = await pair.make(sealed, `cp-${randomUUID().slice(0, 6)}`);
  const b = await pair.make(sealed, `pod-${randomUUID().slice(0, 6)}`);
  const got = {
    results: [] as StepResult[],
    beats: [] as Heartbeat[],
    decisions: [] as WorkflowDecision[],
    stepEvents: [] as WorkflowStepEvent[],
    starts: [] as StartRunMessage[],
    requests: [] as RunRequest[],
    replies: [] as RunReply[],
    events: [] as TenantEvent[],
    tasks: [] as unknown[],
    turns: [] as WorkflowTask[],
  };
  // The engine side holds everything it would consume until the raw data was inspected.
  a.deferConsumers();
  a.onResult(async (r) => {
    got.results.push(r);
  });
  a.onHeartbeat(async (h) => {
    got.beats.push(h);
  });
  a.onDecision(async (d) => {
    got.decisions.push(d);
  });
  a.onStepEvent(async (e) => {
    got.stepEvents.push(e);
  });
  a.onStartRun(async (m) => {
    got.starts.push(m);
  });
  a.onRunRequest(async (m) => {
    got.requests.push(m);
    await a.publishRunReply({ requestId: m.requestId, result: { ok: true, data: S.reply } });
  });
  b.onRunReply((r) => got.replies.push(r));
  b.onTenantEvent('acme', (e) => got.events.push(e));

  b.handle('pay', async (input, log) => {
    got.tasks.push(input);
    log.heartbeat({ note: S.progress });
    await sleep(50);
    return { receipt: S.output };
  });
  b.handleWorkflow('checkout', async (task) => {
    got.turns.push(task);
    await b.dispatchStepEvent({
      runId: task.runId,
      seq: 1,
      name: 'local',
      phase: 'completed',
      startedAt: 1,
      output: S.stepEvent,
    });
    return {
      taskId: task.taskId,
      runId: task.runId,
      status: 'continue',
      commands: [{ kind: 'startChild', seq: 2, workflow: 'child', input: S.child }],
    };
  });

  const task: RemoteTask = {
    runId: 'run-1',
    seq: 0,
    stepId: 'run-1:0',
    name: 'pay',
    group: sanitizeQueueToken('pay'),
    input: { card: S.input },
    context: { user: S.context },
    attempt: 1,
  };
  await a.dispatch(task);
  await a.dispatchWorkflowTask({
    taskId: 'run-2:t1',
    runId: 'run-2',
    workflow: 'checkout',
    workflowVersion: '1',
    input: { cart: S.input },
    history: [{ seq: 0, kind: 'step', output: S.history }],
    pendingSignals: [{ seq: 1, signal: 'go', payload: S.signal }],
    group: sanitizeQueueToken('checkout'),
    attempt: 1,
  });
  await b.dispatchStartRun({
    tenant: S.token,
    workflow: 'checkout',
    input: S.startInput,
    runId: 'run-3',
  });
  await b.dispatchRunRequest({
    requestId: 'req-1',
    tenant: S.token,
    body: { kind: 'signal', runId: 'run-1', signal: 'go', payload: S.signalPayload },
  });

  // The worker ran the step and the turn; their results, beats, decisions and events wait.
  await until(() => got.tasks.length === 1 && got.turns.length === 1);
  await sleep(300);
  const raw = await pair.dump();

  a.startConsumers();
  await until(
    () =>
      got.results.length >= 1 &&
      got.decisions.length >= 1 &&
      got.stepEvents.length >= 1 &&
      got.starts.length >= 1 &&
      got.replies.length >= 1,
  );
  // Tenant events: the control plane publishes once the pod's subscription is known.
  await until(async () => {
    await a.publishTenantEvent({
      tenant: 'acme',
      event: { type: 'run.completed', runId: 'run-1', output: S.event } as never,
    });
    await sleep(50);
    return got.events.length >= 1;
  });
  const afterAll = await pair.dump();
  return { got, raw: `${raw}\n${afterAll}`, a, b };
}

function expectNoSecrets(raw: string, S: ReturnType<typeof secrets>) {
  for (const [label, value] of Object.entries(S)) {
    expect(raw.includes(value), `${label} appears in clear on the broker`).toBe(false);
  }
}

function suite(name: string, pair: () => Promise<Pair>) {
  describe(name, () => {
    it('seals every message kind: nothing readable on the broker, everything intact on arrival', async () => {
      const S = secrets();
      const { got, raw } = await exchange(await pair(), S);
      expectNoSecrets(raw, S);
      expect(raw).toMatch(/dm1\.k\./);

      expect(got.tasks[0]).toEqual({ card: S.input });
      expect(got.results[0]).toMatchObject({
        runId: 'run-1',
        status: 'completed',
        output: { receipt: S.output },
      });
      expect(got.turns[0]?.history[0]?.output).toBe(S.history);
      expect(got.turns[0]?.pendingSignals?.[0]?.payload).toBe(S.signal);
      expect(got.decisions[0]?.commands[0]).toMatchObject({ kind: 'startChild', input: S.child });
      expect(got.stepEvents[0]?.output).toBe(S.stepEvent);
      expect(got.starts[0]).toMatchObject({ tenant: S.token, input: S.startInput, runId: 'run-3' });
      expect(got.requests[0]?.body).toMatchObject({ payload: S.signalPayload });
      expect(got.replies[0]).toEqual({ requestId: 'req-1', result: { ok: true, data: S.reply } });
      expect((got.events[0]?.event as unknown as { output?: string } | undefined)?.output).toBe(
        S.event,
      );
      // The db transport stores no heartbeat progress; the others carry it sealed.
      if (!name.startsWith('db')) {
        await until(() =>
          got.beats.some((b) => (b.progress as { note?: string })?.note === S.progress),
        );
      }
    });

    it('seals control messages', async () => {
      const p = await pair();
      if (!p.control) return;
      const S = secrets();
      const sender = await p.control({ appKey: APP_KEY, seal: true });
      const receiver = await p.control({ appKey: APP_KEY, seal: true });
      const seen: ControlMessage[] = [];
      receiver.receive((m) => seen.push(m));
      await sleep(100);
      await until(async () => {
        await sender.publish({
          kind: 'event',
          event: { type: 'run.completed', runId: 'r', output: S.control } as never,
        });
        await sleep(50);
        return seen.length > 0;
      });
      expect((seen[0] as { event: { output: string } }).event.output).toBe(S.control);
      expectNoSecrets(await p.dump(), S);
    });

    it('refuses a task sealed with another key: the handler never runs, the step is reported failed', async () => {
      const p = await pair();
      const foreign = await p.make(
        { appKey: OTHER_KEY, seal: true },
        `foreign-${randomUUID().slice(0, 6)}`,
      );
      const engine = await p.make(
        { appKey: APP_KEY, seal: true },
        `cp-${randomUUID().slice(0, 6)}`,
      );
      const worker = await p.make(
        { appKey: APP_KEY, seal: true },
        `pod-${randomUUID().slice(0, 6)}`,
      );
      const results: StepResult[] = [];
      let ran = false;
      engine.onResult(async (r) => {
        results.push(r);
      });
      worker.handle('pay', async () => {
        ran = true;
        return 'never';
      });
      await foreign.dispatch({
        runId: 'run-x',
        seq: 0,
        stepId: 'run-x:0',
        name: 'pay',
        group: sanitizeQueueToken('pay'),
        input: { n: 1 },
        attempt: 1,
      });
      await until(() => results.length > 0);
      expect(ran).toBe(false);
      expect(results[0]).toMatchObject({ runId: 'run-x', status: 'failed' });
      expect(results[0]?.error?.message).toMatch(/does not open with this app key/);
    });

    it('replies in kind: a plain task (a process not upgraded yet) gets a plain result it can read', async () => {
      const p = await pair();
      // `insecure` without a key: it cannot open a sealed message at all, like a 1.1 process.
      const old = await p.make({ insecure: true }, `old-${randomUUID().slice(0, 6)}`);
      const worker = await p.make(
        { appKey: APP_KEY, seal: true },
        `new-${randomUUID().slice(0, 6)}`,
      );
      const results: StepResult[] = [];
      old.onResult(async (r) => {
        results.push(r);
      });
      worker.handle('pay', async (input) => ({ got: input }));
      await old.dispatch({
        runId: 'run-k',
        seq: 0,
        stepId: 'run-k:0',
        name: 'pay',
        group: sanitizeQueueToken('pay'),
        input: { n: 3 },
        attempt: 1,
      });
      await until(() => results.length > 0);
      expect(results[0]).toMatchObject({ status: 'completed', output: { got: { n: 3 } } });
    });

    it('mixed rollout: plain messages are accepted by default, refused with acceptPlain: false', async () => {
      const p = await pair();
      const old = await p.make({ insecure: true }, `old-${randomUUID().slice(0, 6)}`);
      const engine = await p.make(
        { appKey: APP_KEY, seal: true },
        `cp-${randomUUID().slice(0, 6)}`,
      );
      const results: StepResult[] = [];
      engine.onResult(async (r) => {
        results.push(r);
      });
      const lenient = await p.make(
        { appKey: APP_KEY, seal: true },
        `new-${randomUUID().slice(0, 6)}`,
      );
      const inputs: unknown[] = [];
      lenient.handle('pay', async (input) => {
        inputs.push(input);
        return 'ok';
      });
      const plainTask = (runId: string): RemoteTask => ({
        runId,
        seq: 0,
        stepId: `${runId}:0`,
        name: 'pay',
        group: sanitizeQueueToken('pay'),
        input: { n: 7 },
        attempt: 1,
      });
      await old.dispatch(plainTask('run-m'));
      await until(() => results.some((r) => r.runId === 'run-m'));
      expect(inputs).toEqual([{ n: 7 }]);
      expect(results.find((r) => r.runId === 'run-m')).toMatchObject({
        status: 'completed',
        output: 'ok',
      });
      await lenient.close();

      const strict = await p.make(
        { appKey: APP_KEY, seal: true, acceptPlain: false },
        `strict-${randomUUID().slice(0, 6)}`,
      );
      let ran = false;
      strict.handle('pay', async () => {
        ran = true;
        return 'never';
      });
      await old.dispatch(plainTask('run-s'));
      await until(() => results.some((r) => r.runId === 'run-s'));
      expect(ran).toBe(false);
      expect(results.find((r) => r.runId === 'run-s')).toMatchObject({ status: 'failed' });
      expect(results.find((r) => r.runId === 'run-s')?.error?.message).toMatch(
        /requires sealed messages/,
      );
    });
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Backends                                                                                    */
/* ------------------------------------------------------------------------------------------- */

interface RawRedis {
  keys(pattern: string): Promise<string[]>;
  type(key: string): Promise<string>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, a: number, b: number): Promise<string[]>;
  zrange(key: string, a: number, b: number): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
  xrange(key: string, a: string, b: string): Promise<unknown>;
  psubscribe(pattern: string): Promise<unknown>;
  on(event: string, fn: (...args: string[]) => void): unknown;
  del(...keys: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

async function dumpRedis(redis: RawRedis, pattern: string): Promise<string> {
  const out: string[] = [];
  for (const key of await redis.keys(pattern)) {
    const type = await redis.type(key);
    if (type === 'hash') out.push(JSON.stringify(await redis.hgetall(key)));
    else if (type === 'list') out.push(JSON.stringify(await redis.lrange(key, 0, -1)));
    else if (type === 'zset') out.push(JSON.stringify(await redis.zrange(key, 0, -1)));
    else if (type === 'set') out.push(JSON.stringify(await redis.smembers(key)));
    else if (type === 'string') out.push(String(await redis.get(key)));
    else if (type === 'stream') out.push(JSON.stringify(await redis.xrange(key, '-', '+')));
  }
  return out.join('\n');
}

async function rawRedis(): Promise<RawRedis> {
  const deps = await createBullMQDeps({ url: REDIS_URL } as unknown);
  const redis = deps.makeRedis() as unknown as RawRedis;
  cleanups.push(() => redis.quit());
  return redis;
}

/** A subscriber recording everything published on channels matching `pattern`. */
async function capturePubSub(pattern: string): Promise<string[]> {
  const sub = await rawRedis();
  const seen: string[] = [];
  sub.on('pmessage', (_p: string, _c: string, message: string) => seen.push(message));
  await sub.psubscribe(pattern);
  return seen;
}

if (REDIS_URL) {
  suite('bullmq', async () => {
    const prefix = `dmsg-${randomUUID().slice(0, 8)}`;
    const redis = await rawRedis();
    const published = await capturePubSub(`${prefix}*`);
    cleanups.push(async () => {
      const keys = await redis.keys(`*${prefix}*`);
      if (keys.length) await redis.del(...keys);
    });
    return {
      async make(messages, instanceId) {
        const t = new BullMQTransport({
          deps: await createBullMQDeps({ url: REDIS_URL } as unknown),
          prefix,
          instanceId,
          messages,
          pingIntervalMs: false,
        });
        cleanups.push(() => t.close());
        return t;
      },
      dump: async () => `${await dumpRedis(redis, `*${prefix}*`)}\n${published.join('\n')}`,
      async control(messages) {
        const deps = await createBullMQDeps({ url: REDIS_URL } as unknown);
        const connection = deps.makeRedis();
        const plane = new RedisControlPlane({
          connection: connection as never,
          prefix,
          messages,
          pingIntervalMs: false,
        });
        cleanups.push(async () => {
          await plane.close?.();
          await (connection as unknown as RawRedis).quit().catch(() => undefined);
        });
        return {
          publish: (msg) => plane.publishControl(msg),
          receive: (handler) => plane.onControl(handler),
        };
      },
    };
  });

  suite('queue', async () => {
    const requireFromHere = createRequire(import.meta.url);
    const requireFromQueue = createRequire(requireFromHere.resolve('@adonisjs/queue'));
    const driverPath = requireFromQueue.resolve('@boringnode/queue/drivers/redis_adapter');
    const requireFromBoringnode = createRequire(driverPath);
    const IORedis = requireFromBoringnode('ioredis') as { Redis: new (url: string) => RawRedis };
    const driver = (await import(pathToFileURL(driverPath).href)) as {
      redis: (c: unknown) => AdapterFactory;
    };
    const prefix = `dmsg-${randomUUID().slice(0, 8)}`;
    const keys = new MemoryWorkerKeys();
    const redis = await rawRedis();
    const make: Pair['make'] = async (messages, instanceId) => {
      const client = new IORedis.Redis(REDIS_URL as string);
      const t = new QueueTransport({
        adapter: driver.redis(client),
        prefix,
        instanceId,
        messages,
        pollIntervalMs: 5,
        stalledCheckIntervalMs: 0,
        tenantSubscribersCacheMs: 0,
        workerKeys: keys,
      });
      cleanups.push(async () => {
        await t.close();
        await client.quit().catch(() => undefined);
      });
      return t;
    };
    return {
      make,
      dump: () => dumpRedis(redis, `*${prefix}*`),
      async control(messages) {
        const q = (await make(messages, `ctl-${randomUUID().slice(0, 6)}`)) as QueueTransport;
        return {
          publish: (msg) => q.publishControl(msg),
          receive: (handler) => q.onControl(handler),
        };
      },
    };
  });
}

for (const backend of dbBackends({ mysql: true })) {
  suite(backend.name === 'sqlite' ? 'db' : `db (${backend.name})`, async () => {
    const db: Database = await backend.makeTransportDb();
    cleanups.push(() => db.manager.closeAll());
    const make: Pair['make'] = async (messages, instanceId) => {
      const t = new DbTransport({
        db,
        instanceId,
        messages,
        pollIntervalMs: 5,
        tenantSubscribersCacheMs: 0,
      });
      cleanups.push(() => t.close());
      return t;
    };
    return {
      make,
      async dump() {
        const out: string[] = [];
        for (const table of Object.values(TRANSPORT_TABLES)) {
          const rows = await db
            .connection()
            .from(table)
            .select('*')
            .catch(() => []);
          out.push(JSON.stringify(rows));
        }
        return out.join('\n');
      },
      async control(messages) {
        const t = (await make(messages, `ctl-${randomUUID().slice(0, 6)}`)) as DbTransport;
        return {
          publish: (msg) => t.publishControl(msg),
          receive: (handler) => t.onControl(handler),
        };
      },
    };
  });
}

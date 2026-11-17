import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, WorkflowTask } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  JobLike,
  ProcessFn,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';

// ---------------------------------------------------------------------------
// In-memory fake broker: queues record adds, workers expose their processor, and the Redis fake
// answers EXISTS from a key set the test controls (the drain check's only command).
// ---------------------------------------------------------------------------

class FakeQueue implements QueueLike {
  adds: Array<{ name: string; data: unknown; opts: unknown }> = [];
  counts: Record<string, number> = {};
  jobs: JobLike[] = [];
  constructor(readonly name: string) {}
  async add(name: string, data: unknown, opts?: unknown): Promise<unknown> {
    this.adds.push({ name, data, opts });
    return {};
  }
  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(types.map((t) => [t, this.counts[t] ?? 0]));
  }
  async getJobs(): Promise<JobLike[]> {
    return this.jobs;
  }
  async close(): Promise<unknown> {
    return undefined;
  }
}

class FakeWorker implements WorkerLike {
  closed = false;
  failed?: (job: JobLike | undefined, err: Error) => void;
  constructor(
    readonly name: string,
    readonly process: ProcessFn,
    public concurrency?: number,
  ) {}
  on(_event: 'failed', listener: (job: JobLike | undefined, err: Error) => void): unknown {
    this.failed = listener;
    return this;
  }
  async close(): Promise<unknown> {
    this.closed = true;
    return undefined;
  }
}

class FakeRedis implements RedisLike {
  keys = new Set<string>();
  existsCalls: string[][] = [];
  async publish(): Promise<unknown> {
    return 1;
  }
  async subscribe(): Promise<unknown> {
    return 1;
  }
  on(): unknown {
    return this;
  }
  async set(): Promise<unknown> {
    return 'OK';
  }
  async exists(...keys: string[]): Promise<number> {
    this.existsCalls.push(keys);
    return keys.filter((k) => this.keys.has(k)).length;
  }
  async del(): Promise<number> {
    return 0;
  }
  async scan(): Promise<[string, string[]]> {
    return ['0', []];
  }
  async get(): Promise<string | null> {
    return null;
  }
  disconnect(): void {}
}

class FakeBroker implements BullMQDeps {
  queues = new Map<string, FakeQueue>();
  workers = new Map<string, FakeWorker>();
  workerLog: string[] = [];
  redis = new FakeRedis();
  defaultConcurrency = 1;
  makeQueue(name: string): QueueLike {
    let q = this.queues.get(name);
    if (!q) {
      q = new FakeQueue(name);
      this.queues.set(name, q);
    }
    return q;
  }
  makeWorker(name: string, process: ProcessFn, opts?: { concurrency?: number }): WorkerLike {
    const w = new FakeWorker(name, process, opts?.concurrency);
    this.workers.set(name, w);
    this.workerLog.push(name);
    return w;
  }
  makeRedis(): RedisLike {
    return this.redis;
  }
}

const task = (name: string, over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name,
  stepId: `r1:${name}`,
  group: name,
  input: {},
  attempt: 0,
  ...over,
});

/** A job the fake worker hands its processor; `moveToDelayed` records hand-backs. */
function job(data: unknown, id?: string): JobLike & { delayedTo?: number } {
  const j: JobLike & { delayedTo?: number } = {
    id,
    data,
    moveToDelayed: async (timestamp: number) => {
      j.delayedTo = timestamp;
    },
  };
  return j;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const open: BullMQTransport[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

function grouped(broker: FakeBroker, extra: Record<string, unknown> = {}): BullMQTransport {
  const t = new BullMQTransport({
    deps: broker,
    instanceId: 'w1',
    taskQueues: 'grouped',
    closeTimeoutMs: 50,
    ...extra,
  });
  open.push(t);
  return t;
}

describe("BullMQTransport taskQueues: 'grouped'", () => {
  it('dispatches every token of a partition to one queue, keeping the token in the job', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker);
    await t.dispatch(task('payments.charge'));
    await t.dispatchMany([task('emails.send'), task('emails.send', { group: 'emails.send@eu' })]);
    await t.dispatchWorkflowTask({
      taskId: 't1',
      runId: 'r1',
      workflow: 'onboarding',
      group: 'onboarding',
      input: {},
      history: [],
    } as unknown as WorkflowTask);

    expect([...broker.queues.keys()].sort()).toEqual(['durable-taskgroup', 'durable-taskgroup@eu']);
    const shared = broker.queues.get('durable-taskgroup') as FakeQueue;
    expect(shared.adds.map((a) => [a.name, (a.data as { group: string }).group])).toEqual([
      ['task', 'payments.charge'],
      ['task', 'emails.send'],
      ['workflow', 'onboarding'],
    ]);
  });

  it('per-handler stays the default layout', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({ deps: broker, instanceId: 'w1' });
    open.push(t);
    await t.dispatch(task('payments.charge'));
    t.handle('payments.charge', async () => 'ok');
    expect([...broker.queues.keys()]).toEqual(['durable-tasks-payments.charge']);
    expect(broker.workerLog).toEqual(['durable-tasks-payments.charge']);
  });

  it('one worker serves every handler, at two limits per handler, and each token is still advertised', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker, { concurrency: 3 });
    t.handle('a', async () => 'a');
    t.handle('b', async () => 'b');
    t.handle('c', async () => 'c');
    t.handle('c', async () => 'c2'); // re-registering swaps the fn only
    expect(broker.workerLog).toEqual(['durable-taskgroup']);
    expect(broker.workers.get('durable-taskgroup')?.concurrency).toBe(18);
    expect((await t.listWorkerGroups()).sort()).toEqual(['a', 'b', 'c']);
  });

  it('routes a job to its handler by the token it carries', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker);
    const ran: string[] = [];
    t.handle('a', async () => {
      ran.push('a');
      return 1;
    });
    t.handle('b', async () => {
      ran.push('b');
      return 2;
    });
    const worker = broker.workers.get('durable-taskgroup') as FakeWorker;
    await worker.process(job(task('b')));
    await worker.process(job(task('a')));
    expect(ran).toEqual(['b', 'a']);
    const results = broker.queues.get('durable-results') as FakeQueue;
    expect(results.adds.map((a) => (a.data as { output: unknown }).output)).toEqual([2, 1]);
  });

  it('keeps each handler at its own limit: one more waits in-process, the rest are handed back', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker); // limit 1 per handler
    const gate = deferred();
    let runningA = 0;
    let maxA = 0;
    t.handle('a', async () => {
      runningA += 1;
      maxA = Math.max(maxA, runningA);
      await gate.promise;
      runningA -= 1;
      return 'a';
    });
    t.handle('b', async () => 'b');
    const worker = broker.workers.get('durable-taskgroup') as FakeWorker;

    const first = worker.process(job(task('a', { seq: 1 }), 'j1'));
    const second = worker.process(job(task('a', { seq: 2 }), 'j2'));
    const thirdJob = job(task('a', { seq: 3 }), 'j3');
    const before = Date.now();
    await expect(worker.process(thirdJob)).rejects.toMatchObject({ name: 'DelayedError' });
    expect(thirdJob.delayedTo).toBeGreaterThanOrEqual(before + 250);

    // Another handler is not held up by a's backlog.
    await worker.process(job(task('b'), 'jb'));
    expect(runningA).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(maxA).toBe(1);
  });

  it('hands the same overflowing job back with a growing delay', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker);
    const gate = deferred();
    t.handle('a', async () => {
      await gate.promise;
      return 'a';
    });
    const worker = broker.workers.get('durable-taskgroup') as FakeWorker;
    const running = worker.process(job(task('a', { seq: 1 }), 'j1'));
    const parked = worker.process(job(task('a', { seq: 2 }), 'j2'));
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const j = job(task('a', { seq: 3 }), 'j3');
      const at = Date.now();
      await expect(worker.process(j)).rejects.toMatchObject({ name: 'DelayedError' });
      delays.push((j.delayedTo as number) - at);
    }
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
    gate.resolve();
    await Promise.all([running, parked]);
  });

  it('hands back a job for a handler this process does not serve, and reports it once', async () => {
    const broker = new FakeBroker();
    const errors: unknown[] = [];
    const t = grouped(broker, { onError: (err: unknown) => errors.push(err) });
    t.handle('a', async () => 'a');
    const worker = broker.workers.get('durable-taskgroup') as FakeWorker;
    const foreign = job(task('elsewhere'), 'jx');
    const at = Date.now();
    await expect(worker.process(foreign)).rejects.toMatchObject({ name: 'DelayedError' });
    await expect(worker.process(job(task('elsewhere'), 'jy'))).rejects.toMatchObject({
      name: 'DelayedError',
    });
    expect(foreign.delayedTo).toBeGreaterThanOrEqual(at + 10_000);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("'elsewhere'");
    expect(broker.queues.get('durable-results')).toBeUndefined();
  });

  it('a raised adaptive/explicit limit reaches the shared worker and the limiter', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker, { concurrency: { mode: 'adaptive', min: 1, max: 8, start: 2 } });
    t.handle('a', async () => 'a');
    t.handle('b', async () => 'b');
    expect(broker.workers.get('durable-taskgroup')?.concurrency).toBe(8);
  });

  it('close() hands back jobs still waiting for a slot at once', async () => {
    const broker = new FakeBroker();
    const t = new BullMQTransport({
      deps: broker,
      instanceId: 'w1',
      taskQueues: 'grouped',
      closeTimeoutMs: 5_000,
    });
    const gate = deferred();
    t.handle('a', async () => {
      await gate.promise;
      return 'a';
    });
    const worker = broker.workers.get('durable-taskgroup') as FakeWorker;
    const running = worker.process(job(task('a', { seq: 1 }), 'j1'));
    // Like a real BullMQ worker, close() waits for the running job's processor to settle.
    worker.close = async () => running.catch(() => undefined);
    const parkedJob = job(task('a', { seq: 2 }), 'j2');
    const parked = worker.process(parkedJob).then(
      () => undefined,
      (err: Error) => err,
    );
    await tick();
    const t0 = Date.now();
    const closing = t.close();
    expect(await parked).toMatchObject({ name: 'DelayedError' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(parkedJob.delayedTo).toBeDefined();
    gate.resolve();
    await running;
    await closing;
  });

  it('groupHealth splits the shared queue per token and names it', async () => {
    const broker = new FakeBroker();
    const t = grouped(broker);
    const q = broker.makeQueue('durable-taskgroup') as FakeQueue;
    q.counts = { waiting: 3, active: 1 };
    q.jobs = [job(task('a')), job(task('a')), job(task('b')), job(task('a'))];
    t.handle('a', async () => 'a');
    expect(await t.groupHealth('a')).toMatchObject({
      group: 'a',
      depth: 3,
      queue: 'durable-taskgroup',
      queueDepth: 4,
    });
    const b = await t.groupHealth('b');
    expect(b.depth).toBe(1);
    expect(b.depthSampled).toBeUndefined();
    expect(b.liveWorkers).toEqual([]);
  });
});

describe('taskQueueDrain', () => {
  const legacyKeys = (queue: string) => [`bull:${queue}:wait`, `bull:${queue}:delayed`];

  it('grouped: drains a per-handler queue while it has jobs, with one EXISTS per check when idle', async () => {
    const broker = new FakeBroker();
    broker.redis.keys.add(legacyKeys('durable-tasks-a')[1] as string);
    const t = grouped(broker, { taskQueueDrain: { intervalMs: 20 } });
    const ran: string[] = [];
    t.handle('a', async () => {
      ran.push('a');
      return 'a';
    });
    t.handle('b', async () => 'b');
    await until(() => broker.workers.has('durable-tasks-a'));
    expect(t.drainingQueues).toEqual(['durable-tasks-a']);
    expect(broker.workers.has('durable-tasks-b')).toBe(false);

    // A legacy job is routed through the same handler (and limiter).
    await (broker.workers.get('durable-tasks-a') as FakeWorker).process(job(task('a'), 'old'));
    expect(ran).toEqual(['a']);

    broker.redis.keys.clear();
    await until(() => broker.workers.get('durable-tasks-a')?.closed === true);
    expect(t.drainingQueues).toEqual([]);

    // Idle: each check is one EXISTS naming every per-handler queue's work keys.
    const calls = broker.redis.existsCalls.length;
    await until(() => broker.redis.existsCalls.length >= calls + 2);
    const last = broker.redis.existsCalls.at(-1) as string[];
    expect(last).toContain('bull:durable-tasks-a:wait');
    expect(last).toContain('bull:durable-tasks-b:prioritized');
  });

  it('per-handler: off by default; on, it drains the grouped queue (a rollback)', async () => {
    const broker = new FakeBroker();
    broker.redis.keys.add('bull:durable-taskgroup:wait');
    const off = new BullMQTransport({ deps: broker, instanceId: 'w1' });
    open.push(off);
    off.handle('a', async () => 'a');
    await new Promise((r) => setTimeout(r, 30));
    expect(broker.redis.existsCalls).toEqual([]);

    const broker2 = new FakeBroker();
    broker2.redis.keys.add('bull:durable-taskgroup:wait');
    const on = new BullMQTransport({
      deps: broker2,
      instanceId: 'w2',
      taskQueueDrain: { intervalMs: 20 },
    });
    open.push(on);
    on.handle('a', async () => 'a');
    await until(() => broker2.workers.has('durable-taskgroup'));
    expect(on.drainingQueues).toEqual(['durable-taskgroup']);
  });

  it('a deferred (producer) process never drains', async () => {
    const broker = new FakeBroker();
    broker.redis.keys.add('bull:durable-tasks-a:wait');
    const t = grouped(broker, { taskQueueDrain: { intervalMs: 10 } });
    t.deferConsumers();
    t.handle('a', async () => 'a');
    await new Promise((r) => setTimeout(r, 40));
    expect(broker.redis.existsCalls).toEqual([]);
    t.startConsumers();
    await until(() => broker.workers.has('durable-tasks-a'));
  });
});

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

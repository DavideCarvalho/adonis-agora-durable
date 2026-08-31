import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Heartbeat,
  RemoteTask,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  TenantEvent,
} from '../../../../src/interfaces.js';
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
// In-memory fake broker — proves naming + job shape + the heartbeat registry with no Redis.
// ---------------------------------------------------------------------------

interface AddCall {
  name: string;
  data: unknown;
  opts: unknown;
}
class FakeQueue implements QueueLike {
  adds: AddCall[] = [];
  counts: Record<string, number> = {};
  closed = false;
  constructor(readonly name: string) {}
  async add(name: string, data: unknown, opts?: unknown): Promise<unknown> {
    this.adds.push({ name, data, opts });
    return { id: `${this.adds.length}` };
  }
  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(types.map((t) => [t, this.counts[t] ?? 0]));
  }
  async close(): Promise<unknown> {
    this.closed = true;
    return undefined;
  }
}

class FakeWorker implements WorkerLike {
  failedListener?: (job: JobLike | undefined, err: Error) => void;
  closed = false;
  constructor(
    readonly name: string,
    readonly process: ProcessFn,
  ) {}
  on(_event: 'failed', listener: (job: JobLike | undefined, err: Error) => void): unknown {
    this.failedListener = listener;
    return this;
  }
  async close(): Promise<unknown> {
    this.closed = true;
    return undefined;
  }
}

interface SetCall {
  key: string;
  value: string;
  mode: string;
  ttl: number;
}
class FakeRedis implements RedisLike {
  store = new Map<string, string>();
  setCalls: SetCall[] = [];
  subscribed: string[] = [];
  disconnected = 0;
  messageListeners: Array<(channel: string, payload: string) => void> = [];
  async publish(channel: string, message: string): Promise<unknown> {
    for (const l of this.messageListeners) l(channel, message);
    return 1;
  }
  async subscribe(channel: string): Promise<unknown> {
    this.subscribed.push(channel);
    return 1;
  }
  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'message') {
      this.messageListeners.push(listener as unknown as (c: string, p: string) => void);
    }
    return this;
  }
  async set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown> {
    this.setCalls.push({ key, value, mode, ttl });
    this.store.set(key, value);
    return 'OK';
  }
  async scan(_cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    // args = ['MATCH', pattern, 'COUNT', n]
    const pattern = String(args[1] ?? '*');
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  disconnect(): void {
    this.disconnected += 1;
  }
}

class FakeBroker implements BullMQDeps {
  queues = new Map<string, FakeQueue>();
  workers = new Map<string, FakeWorker>();
  redis = new FakeRedis();
  makeQueue(name: string): QueueLike {
    let q = this.queues.get(name);
    if (!q) {
      q = new FakeQueue(name);
      this.queues.set(name, q);
    }
    return q;
  }
  makeWorker(name: string, process: ProcessFn): WorkerLike {
    const w = new FakeWorker(name, process);
    this.workers.set(name, w);
    return w;
  }
  makeRedis(): RedisLike {
    return this.redis; // shared, so pub/sub + heartbeat keys connect in-memory
  }
}

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 2,
  name: 'payments.charge',
  stepId: 'r1:2',
  group: 'payments.charge',
  input: { amount: 100 },
  attempt: 0,
  ...over,
});

describe('BullMQTransport', () => {
  let broker: FakeBroker;
  let transport: BullMQTransport;

  beforeEach(() => {
    broker = new FakeBroker();
    transport = new BullMQTransport({ deps: broker, instanceId: 'ts-box-1' });
  });

  describe('dispatch (engine → worker)', () => {
    it('adds a `task` job to `durable-tasks-<group>` with the raw DTO (no envelope) + task opts', async () => {
      await transport.dispatch(task({ group: 'payments.charge', priority: 5 }));
      const q = broker.queues.get('durable-tasks-payments.charge');
      expect(q).toBeDefined();
      expect(q?.adds).toHaveLength(1);
      const add = q!.adds[0]!;
      expect(add.name).toBe('task');
      expect(add.data).toEqual(task({ group: 'payments.charge', priority: 5 }));
      expect(add.opts).toEqual({
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
        priority: 1_048_571,
      });
    });

    it('targets the FINAL routing token carried on task.group (tenant-suffixed queue)', async () => {
      await transport.dispatch(task({ group: 'payments.charge@acme' }));
      expect(broker.queues.has('durable-tasks-payments.charge@acme')).toBe(true);
    });

    it('dispatchWorkflowTask adds a `workflow` job with the non-task opts', async () => {
      await transport.dispatchWorkflowTask({
        taskId: 't1',
        runId: 'r1',
        workflow: 'checkout',
        workflowVersion: '1.0.0',
        input: {},
        history: [],
        group: 'checkout',
        attempt: 0,
      });
      const add = broker.queues.get('durable-tasks-checkout')?.adds[0];
      expect(add?.name).toBe('workflow');
      expect(add?.opts).toEqual({ removeOnComplete: true, removeOnFail: true });
    });
  });

  describe('worker → engine consumers', () => {
    it('onResult starts a worker on `durable-results` that hands job.data to the handler', async () => {
      const handler = vi.fn(async () => {});
      transport.onResult(handler);
      const w = broker.workers.get('durable-results');
      expect(w).toBeDefined();
      const result: StepResult = { runId: 'r1', seq: 2, stepId: 'r1:2', status: 'completed' };
      await w!.process({ data: result });
      expect(handler).toHaveBeenCalledWith(result);
    });

    it('onDecision consumes `durable-decisions`; onStepEvent consumes `durable-step-events`', async () => {
      transport.onDecision(async () => {});
      transport.onStepEvent(async () => {});
      expect(broker.workers.has('durable-decisions')).toBe(true);
      expect(broker.workers.has('durable-step-events')).toBe(true);
    });

    it('dispatchStepEvent adds a `stepEvent` job with non-task opts', async () => {
      await transport.dispatchStepEvent({
        runId: 'r1',
        seq: 2,
        name: 'x',
        phase: 'running',
        startedAt: 1,
      });
      const add = broker.queues.get('durable-step-events')?.adds[0];
      expect(add?.name).toBe('stepEvent');
      expect(add?.opts).toEqual({ removeOnComplete: true, removeOnFail: true });
    });
  });

  describe('handle (worker side)', () => {
    it("starts a dedicated task worker on the name's routing-token queue", () => {
      transport.handle('extraction:page', async () => 'ok');
      // ':' sanitized to '-'
      expect(broker.workers.has('durable-tasks-extraction-page')).toBe(true);
    });

    it('runs the handler and adds a completed StepResult to `durable-results`', async () => {
      transport.handle('payments.charge', async (input) => ({ ok: input }));
      const w = broker.workers.get('durable-tasks-payments.charge')!;
      await w.process({ data: task() });
      const add = broker.queues.get('durable-results')?.adds[0];
      expect(add?.name).toBe('result');
      const result = add?.data as StepResult;
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({ ok: { amount: 100 } });
      expect(result.runId).toBe('r1');
      expect(result.seq).toBe(2);
      expect(result.stepId).toBe('r1:2');
    });

    it("stamps a TTL'd worker-liveness key immediately: SET durable-worker-heartbeat:<token>:<instance> EX 35", () => {
      transport.handle('proc', async () => {});
      const call = broker.redis.setCalls.at(-1);
      expect(call?.key).toBe('durable-worker-heartbeat:proc:ts-box-1');
      expect(call?.mode).toBe('EX');
      expect(call?.ttl).toBe(35);
      expect(JSON.parse(call!.value)).toMatchObject({ ts: expect.any(Number) });
    });
  });

  describe('terminal-failure bridge', () => {
    it('publishes a RETRYABLE failed StepResult when a task job reaches terminal `failed`', async () => {
      transport.handle('proc', async () => {});
      const w = broker.workers.get('durable-tasks-proc')!;
      w.failedListener?.({ data: task(), failedReason: 'stalled' }, new Error('boom'));
      await Promise.resolve();
      const add = broker.queues.get('durable-results')?.adds.at(-1);
      const result = add?.data as StepResult;
      expect(result.status).toBe('failed');
      expect(result.error?.retryable).toBe(true);
      expect(result.error?.message).toContain('stalled');
      // correlation only — no `name` invented
      expect(result).not.toHaveProperty('name');
    });

    it("no-ops when the failed job payload was GC'd/malformed (nothing safe to publish)", async () => {
      transport.handle('proc', async () => {});
      const w = broker.workers.get('durable-tasks-proc')!;
      w.failedListener?.(undefined, new Error('boom'));
      await Promise.resolve();
      expect(broker.queues.get('durable-results')?.adds ?? []).toHaveLength(0);
    });
  });

  describe('handleWorkflow (worker side — workflow turns, spec §6.3)', () => {
    it("starts a task worker on the workflow name's queue and stamps its liveness key", () => {
      transport.handleWorkflow('checkout', async (t) => ({
        taskId: t.taskId,
        runId: t.runId,
        status: 'completed',
        commands: [],
      }));
      expect(broker.workers.has('durable-tasks-checkout')).toBe(true);
      expect(broker.redis.setCalls.at(-1)?.key).toBe('durable-worker-heartbeat:checkout:ts-box-1');
    });

    it('routes a workflow-shaped job to the turn and publishes its decision on `durable-decisions`', async () => {
      transport.handleWorkflow('checkout', async (t) => ({
        taskId: t.taskId,
        runId: t.runId,
        status: 'continue',
        commands: [{ kind: 'call', seq: 0, name: 'charge', group: '', input: t.input }],
      }));
      const w = broker.workers.get('durable-tasks-checkout')!;
      await w.process({
        data: {
          taskId: 'wf1',
          runId: 'r9',
          workflow: 'checkout',
          workflowVersion: '1',
          input: { amount: 5 },
          history: [],
          group: 'checkout',
          attempt: 0,
        },
      });
      const add = broker.queues.get('durable-decisions')?.adds.at(-1);
      expect(add?.name).toBe('decision');
      expect(add?.opts).toEqual({ removeOnComplete: true, removeOnFail: true });
      expect(add?.data).toMatchObject({ taskId: 'wf1', runId: 'r9', status: 'continue' });
    });

    it('discriminates by SHAPE: a step job on the SAME worker still yields a result, not a decision', async () => {
      // Register BOTH a step handler and a workflow turn whose routing tokens collide on one queue, so the
      // one worker on that queue must route each job by shape (workflow → decision, step → result).
      transport.handle('mixed', async (input) => ({ echoed: input }));
      transport.handleWorkflow('mixed', async (t) => ({
        taskId: t.taskId,
        runId: t.runId,
        status: 'completed',
        commands: [],
        output: 'wf-done',
      }));
      const w = broker.workers.get('durable-tasks-mixed')!;

      await w.process({ data: task({ name: 'mixed', group: 'mixed' }) });
      expect(broker.queues.get('durable-results')?.adds.at(-1)?.name).toBe('result');

      await w.process({
        data: {
          taskId: 'wf2',
          runId: 'r1',
          workflow: 'mixed',
          workflowVersion: '1',
          input: {},
          history: [],
          group: 'mixed',
          attempt: 0,
        },
      });
      const decision = broker.queues.get('durable-decisions')?.adds.at(-1);
      expect(decision?.name).toBe('decision');
      expect(decision?.data).toMatchObject({ status: 'completed', output: 'wf-done' });
    });
  });

  describe('long-step heartbeat pub/sub', () => {
    it('heartbeat() publishes JSON on `durable-heartbeat`; onHeartbeat receives it', async () => {
      const received: Heartbeat[] = [];
      transport.onHeartbeat(async (b) => {
        received.push(b);
      });
      expect(broker.redis.subscribed).toContain('durable-heartbeat');
      const beat: Heartbeat = { runId: 'r1', seq: 2, stepId: 'r1:2', group: 'proc' };
      await transport.heartbeat(beat);
      await Promise.resolve();
      expect(received).toEqual([beat]);
    });

    it('a beating step handler run through `handle()` delivers at least one heartbeat for its own stepId (regression: #runTask must pass the emitBeat callback to runStepHandler)', async () => {
      const received: Heartbeat[] = [];
      transport.onHeartbeat(async (b) => {
        received.push(b);
      });
      transport.handle('proc', async (_input, log) => {
        log.heartbeat({ done: 1 });
        return 'ok';
      });
      const w = broker.workers.get('durable-tasks-proc')!;
      await w.process({ data: task({ name: 'proc', group: 'proc' }) });
      // The heartbeat publish is fire-and-forget (protocol.ts's `beat` wraps it in `void
      // Promise.resolve(...).catch(...)`), so give the microtask queue a turn before asserting.
      await Promise.resolve();
      await Promise.resolve();
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]).toMatchObject({ runId: 'r1', seq: 2, stepId: 'r1:2' });
    });
  });

  describe('worker-health registry', () => {
    it('listWorkerGroups discovers distinct tokens from the heartbeat keyspace', async () => {
      transport.handle('proc', async () => {});
      transport.handle('extraction:page', async () => {});
      expect(await transport.listWorkerGroups()).toEqual(
        expect.arrayContaining(['proc', 'extraction-page']),
      );
    });

    it('groupHealth sums queue depth + lists live workers from the keyspace', async () => {
      transport.handle('proc', async () => {});
      const q = broker.makeQueue('durable-tasks-proc') as FakeQueue;
      q.counts = { waiting: 2, active: 1, delayed: 0, prioritized: 3 };
      const health = await transport.groupHealth('proc');
      expect(health.group).toBe('proc');
      expect(health.depth).toBe(6);
      expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['ts-box-1']);
    });

    it('listWorkerDescriptors SCANs the `${P}-worker-descriptor:<token>:*` keys and parses each', async () => {
      const d1 = {
        instanceId: 'w1',
        runtime: 'node',
        sdk: { name: 'x', version: '1' },
        protocol: { version: 1, range: [1, 1] },
        capabilities: ['saga'],
        workflows: [],
        steps: ['proc'],
        startedAt: 1,
      };
      const d2 = { ...d1, instanceId: 'w2', capabilities: ['saga', 'signals'] };
      broker.redis.store.set('durable-worker-descriptor:proc:w1', JSON.stringify(d1));
      broker.redis.store.set('durable-worker-descriptor:proc:w2', JSON.stringify(d2));
      // A descriptor on a DIFFERENT token must not leak into this token's read.
      broker.redis.store.set('durable-worker-descriptor:other:w3', JSON.stringify(d1));

      const descriptors = await transport.listWorkerDescriptors('proc');
      expect(descriptors.map((d) => d.instanceId).sort()).toEqual(['w1', 'w2']);
      expect(descriptors.find((d) => d.instanceId === 'w2')?.capabilities).toEqual([
        'saga',
        'signals',
      ]);
    });

    it('listWorkerDescriptors degrades to [] and never throws on a malformed value', async () => {
      broker.redis.store.set('durable-worker-descriptor:proc:bad', '{not json');
      expect(await transport.listWorkerDescriptors('proc')).toEqual([]);
    });
  });

  describe('namespace folding', () => {
    it('useNamespace segments every name; an explicit constructor namespace wins', async () => {
      const t = new BullMQTransport({ deps: broker, instanceId: 'i', namespace: 'explicit' });
      t.useNamespace('ignored');
      await t.dispatch(task({ group: 'g' }));
      expect(broker.queues.has('durable-explicit-tasks-g')).toBe(true);
    });

    it('useNamespace applies when no explicit namespace was set', async () => {
      await transport.dispatch(task({ group: 'g' })); // no ns
      transport.useNamespace('ns1');
      await transport.dispatch(task({ group: 'g2' }));
      expect(broker.queues.has('durable-tasks-g')).toBe(true);
      expect(broker.queues.has('durable-ns1-tasks-g2')).toBe(true);
    });
  });

  describe('close', () => {
    it('closes workers/queues and disconnects the redis client', async () => {
      transport.handle('proc', async () => {});
      transport.onResult(async () => {});
      transport.onHeartbeat(async () => {});
      await transport.dispatch(task({ group: 'proc' }));
      await transport.close();
      expect(broker.workers.get('durable-tasks-proc')?.closed).toBe(true);
      expect(broker.workers.get('durable-results')?.closed).toBe(true);
      expect(broker.queues.get('durable-tasks-proc')?.closed).toBe(true);
      expect(broker.redis.disconnected).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // P4 — store-less read/control/start protocol (spec §6.2)
  // ---------------------------------------------------------------------------
  describe('P4 start-run / run-request queues', () => {
    const startMsg: StartRunMessage = {
      tenant: 'acme',
      workflow: 'checkout',
      input: { c: 1 },
      runId: 'r1',
    };
    const runReq: RunRequest = {
      requestId: 'req-1',
      tenant: 'acme',
      body: { kind: 'getRun', runId: 'r1' },
    };

    it('dispatchStartRun adds a `startRun` job to `durable-start-run` with non-task opts', async () => {
      await transport.dispatchStartRun(startMsg);
      const add = broker.queues.get('durable-start-run')?.adds[0];
      expect(add?.name).toBe('startRun');
      expect(add?.data).toEqual(startMsg);
      expect(add?.opts).toEqual({ removeOnComplete: true, removeOnFail: true });
    });

    it('onStartRun consumes `durable-start-run`, handing job.data to the handler', async () => {
      const handler = vi.fn(async () => {});
      transport.onStartRun(handler);
      const w = broker.workers.get('durable-start-run');
      expect(w).toBeDefined();
      await w!.process({ data: startMsg });
      expect(handler).toHaveBeenCalledWith(startMsg);
    });

    it('dispatchRunRequest adds a `runRequest` job to `durable-run-request`', async () => {
      await transport.dispatchRunRequest(runReq);
      const add = broker.queues.get('durable-run-request')?.adds[0];
      expect(add?.name).toBe('runRequest');
      expect(add?.data).toEqual(runReq);
      expect(add?.opts).toEqual({ removeOnComplete: true, removeOnFail: true });
    });

    it('onRunRequest consumes `durable-run-request`, handing job.data to the handler', async () => {
      const handler = vi.fn(async () => {});
      transport.onRunRequest(handler);
      const w = broker.workers.get('durable-run-request');
      expect(w).toBeDefined();
      await w!.process({ data: runReq });
      expect(handler).toHaveBeenCalledWith(runReq);
    });

    it('onStartRun / onRunRequest are idempotent (a second call does not replace the worker)', () => {
      const first = vi.fn(async () => {});
      const second = vi.fn(async () => {});
      transport.onStartRun(first);
      transport.onStartRun(second);
      transport.onRunRequest(first);
      transport.onRunRequest(second);
      // Exactly one worker each; the first handler stays wired.
      expect([...broker.workers.keys()].filter((k) => k === 'durable-start-run')).toHaveLength(1);
      expect([...broker.workers.keys()].filter((k) => k === 'durable-run-request')).toHaveLength(1);
    });
  });

  describe('P4 run-reply / tenant-events pub/sub', () => {
    it('publishRunReply publishes JSON on `durable-run-reply`; onRunReply receives it', async () => {
      const reply: RunReply = { requestId: 'req-1', result: { ok: true, data: { n: 1 } } };
      const received: RunReply[] = [];
      transport.onRunReply((r) => received.push(r));
      expect(broker.redis.subscribed).toContain('durable-run-reply');
      await transport.publishRunReply(reply);
      expect(received).toEqual([reply]);
    });

    it('onRunReply ignores messages from OTHER channels (filters by channel on a shared connection)', async () => {
      const received: RunReply[] = [];
      transport.onRunReply((r) => received.push(r));
      // A tenant-event on a different channel must not reach the run-reply handler.
      await transport.publishTenantEvent({
        tenant: 'acme',
        event: { type: 'run.completed', runId: 'r1', at: new Date() },
      });
      expect(received).toEqual([]);
    });

    it('publishTenantEvent fans out on `durable-tenant-events-<tenant>`; onTenantEvent(tenant) receives ITS OWN only', async () => {
      const acme: TenantEvent[] = [];
      const other: TenantEvent[] = [];
      transport.onTenantEvent('acme', (e) => acme.push(e));
      transport.onTenantEvent('other', (e) => other.push(e));
      expect(broker.redis.subscribed).toContain('durable-tenant-events-acme');
      const evt: TenantEvent = {
        tenant: 'acme',
        event: { type: 'run.started', runId: 'r1', namespace: 'acme', at: new Date() },
      };
      await transport.publishTenantEvent(evt);
      // The event crosses the pub/sub as JSON, so its `at` Date arrives as an ISO string — compare
      // against the JSON-roundtripped form (the §6.3 date rule), not the original Date object.
      expect(acme).toEqual([JSON.parse(JSON.stringify(evt))]);
      expect(other).toEqual([]); // a different tenant's channel never sees acme's event
    });

    it('onTenantEvent returns an unsubscribe fn that stops delivery', async () => {
      const seen: TenantEvent[] = [];
      const off = transport.onTenantEvent('acme', (e) => seen.push(e));
      const evt: TenantEvent = {
        tenant: 'acme',
        event: { type: 'run.started', runId: 'r1', namespace: 'acme', at: new Date() },
      };
      await transport.publishTenantEvent(evt);
      off();
      await transport.publishTenantEvent(evt);
      expect(seen).toHaveLength(1); // only the pre-unsubscribe event
    });

    it('namespace folding applies to the P4 channels (an explicit namespace wins)', async () => {
      const t = new BullMQTransport({ deps: broker, instanceId: 'i', namespace: 'ns1' });
      await t.dispatchStartRun({ tenant: 'acme', workflow: 'w', input: null, runId: 'r' });
      t.onRunReply(() => {});
      t.onTenantEvent('acme', () => {});
      expect(broker.queues.has('durable-ns1-start-run')).toBe(true);
      expect(broker.redis.subscribed).toContain('durable-ns1-run-reply');
      expect(broker.redis.subscribed).toContain('durable-ns1-tenant-events-acme');
    });
  });
});

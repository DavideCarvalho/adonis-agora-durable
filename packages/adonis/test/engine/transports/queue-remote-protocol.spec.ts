import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineEvent,
  RemoteTask,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  TenantEvent,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../../src/interfaces.js';
import { hasProxyCapability, hasResponderCapability } from '../../../src/role_bindings.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport, type QueueTransportOptions } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';
import {
  inboxKey,
  runRepliesQueue,
  tenantEventsQueue,
  tenantSubscriberKey,
} from '../../../src/transports/queue-remote.js';
import { MemoryWorkerKeys } from '../../../src/transports/worker-keys.js';

/**
 * The parts of the store-less protocol the queue transport now carries, mirroring the BullMQ protocol
 * tests: remote workflow turns (task → decision), streamed step events, start-run and run-request, and
 * the two that BullMQ broadcasts on Redis PUB/SUB and the queue transport delivers through per-instance
 * inboxes instead — run replies (to the requester only) and tenant events (to every live subscriber of
 * that tenant).
 */

const POLL = 5;

async function until(cond: () => boolean, budgetMs = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const workflowTask = (over: Partial<WorkflowTask> = {}): WorkflowTask => ({
  taskId: 'r1:wf:1',
  runId: 'r1',
  workflow: 'pipeline',
  workflowVersion: '1',
  input: { n: 1 },
  history: [],
  group: sanitizeQueueToken(over.workflow ?? 'pipeline'),
  attempt: 1,
  ...over,
});

const event = (runId: string, n: number): EngineEvent =>
  ({ type: 'step.completed', runId, seq: n, at: new Date(0) }) as unknown as EngineEvent;

describe('QueueTransport — store-less protocol and remote workflows', () => {
  const transports: QueueTransport[] = [];
  const make = (adapter: MockAdapter, opts: Partial<QueueTransportOptions> = {}) => {
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: 0,
      tenantSubscribersCacheMs: 0,
      ...opts,
    });
    transports.push(t);
    return t;
  };

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    vi.restoreAllMocks();
  });

  it('exposes every store-less protocol method the provider feature-detects', () => {
    const t = make(new MockAdapter());
    expect(hasProxyCapability(t)).toBe(true);
    expect(hasResponderCapability(t)).toBe(true);
    expect(typeof t.dispatchWorkflowTask).toBe('function');
    expect(typeof t.handleWorkflow).toBe('function');
  });

  describe('remote workflow turns', () => {
    it('dispatchWorkflowTask → handleWorkflow turn → decision reaches onDecision', async () => {
      const adapter = new MockAdapter();
      const engine = make(adapter);
      const worker = make(adapter);
      const decisions: WorkflowDecision[] = [];
      engine.onDecision(async (d) => void decisions.push(d));
      const seen: WorkflowTask[] = [];
      worker.handleWorkflow('pipeline', async (task) => {
        seen.push(task);
        return { taskId: task.taskId, runId: task.runId, status: 'completed', commands: [] };
      });

      await engine.dispatchWorkflowTask(workflowTask());
      await until(() => decisions.length === 1);
      expect(seen[0]).toMatchObject({ workflow: 'pipeline', input: { n: 1 }, history: [] });
      expect(decisions[0]).toEqual({
        taskId: 'r1:wf:1',
        runId: 'r1',
        status: 'completed',
        commands: [],
      });
    });

    it('the job is a `workflow` job on the routing-token task queue', async () => {
      const adapter = new MockAdapter();
      const engine = make(adapter);
      await engine.dispatchWorkflowTask(workflowTask({ group: 'pipeline@acme' }));
      const [job] = adapter.pending.get('durable:tasks:pipeline@acme') ?? [];
      expect(job?.name).toBe('workflow');
    });

    it('a step and a workflow turn on the SAME token are told apart by shape', async () => {
      const adapter = new MockAdapter();
      const engine = make(adapter);
      const worker = make(adapter);
      const decisions: WorkflowDecision[] = [];
      const results: StepResult[] = [];
      engine.onDecision(async (d) => void decisions.push(d));
      engine.onResult(async (r) => void results.push(r));
      worker.handle('pipeline', async () => 'step-ran');
      worker.handleWorkflow('pipeline', async (task) => ({
        taskId: task.taskId,
        runId: task.runId,
        status: 'completed',
        commands: [],
      }));

      const step: RemoteTask = {
        runId: 'r1',
        seq: 1,
        name: 'pipeline',
        stepId: 'r1:1',
        group: 'pipeline',
        input: null,
        attempt: 1,
      };
      await engine.dispatch(step);
      await engine.dispatchWorkflowTask(workflowTask());
      await until(() => decisions.length === 1 && results.length === 1);
      expect(results[0]).toMatchObject({ status: 'completed', output: 'step-ran' });
      expect(decisions[0]?.status).toBe('completed');
    });

    it('an unknown workflow yields a failed `no_workflow` decision (never hangs)', async () => {
      const adapter = new MockAdapter();
      const engine = make(adapter);
      const worker = make(adapter);
      const decisions: WorkflowDecision[] = [];
      engine.onDecision(async (d) => void decisions.push(d));
      worker.handle('pipeline', async () => 'x'); // the token is served, the workflow is not
      await engine.dispatchWorkflowTask(workflowTask());
      await until(() => decisions.length === 1);
      expect(decisions[0]).toMatchObject({ status: 'failed', error: { code: 'no_workflow' } });
    });

    it('a throwing turn still yields a failed decision', async () => {
      const adapter = new MockAdapter();
      const errors: unknown[] = [];
      const engine = make(adapter);
      const worker = make(adapter, { onError: (e) => errors.push(e) });
      const decisions: WorkflowDecision[] = [];
      engine.onDecision(async (d) => void decisions.push(d));
      worker.handleWorkflow('pipeline', async () => {
        throw new Error('replay exploded');
      });
      await engine.dispatchWorkflowTask(workflowTask());
      await until(() => decisions.length === 1);
      expect(decisions[0]).toMatchObject({
        status: 'failed',
        error: { message: 'replay exploded' },
      });
      expect(errors).toHaveLength(1);
    });

    it('every onDecision handler sees each decision (one executor per remote workflow)', async () => {
      const adapter = new MockAdapter();
      const engine = make(adapter);
      const worker = make(adapter);
      const a: string[] = [];
      const b: string[] = [];
      engine.onDecision(async (d) => void a.push(d.taskId));
      engine.onDecision(async (d) => void b.push(d.taskId));
      worker.handleWorkflow('pipeline', async (task) => ({
        taskId: task.taskId,
        runId: task.runId,
        status: 'completed',
        commands: [],
      }));
      await engine.dispatchWorkflowTask(workflowTask());
      await until(() => a.length === 1 && b.length === 1);
      expect(a).toEqual(['r1:wf:1']);
      expect(b).toEqual(['r1:wf:1']);
    });

    it('step events are point-to-point: two engines checkpoint each event once in total', async () => {
      const adapter = new MockAdapter();
      const worker = make(adapter);
      const e1 = make(adapter);
      const e2 = make(adapter);
      const got: WorkflowStepEvent[] = [];
      e1.onStepEvent(async (e) => void got.push(e));
      e2.onStepEvent(async (e) => void got.push(e));
      for (let seq = 1; seq <= 5; seq += 1) {
        await worker.dispatchStepEvent({
          runId: 'r1',
          seq,
          name: 'side',
          status: 'completed',
        } as unknown as WorkflowStepEvent);
      }
      await until(() => got.length === 5);
      await sleep(30);
      expect(got.map((e) => e.seq).sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('start-run and run-request (point-to-point to the control plane)', () => {
    it('a start-run reaches onStartRun WITHOUT the private reply target, and its reply comes back', async () => {
      const adapter = new MockAdapter();
      const tenant = make(adapter);
      const cp = make(adapter);
      const received: StartRunMessage[] = [];
      cp.onStartRun(async (msg) => {
        received.push(msg);
        await cp.publishRunReply({
          requestId: msg.runId as string,
          result: { ok: true, data: { runId: msg.runId, status: 'pending' } },
        });
      });
      const replies: RunReply[] = [];
      tenant.onRunReply((r) => replies.push(r));

      await tenant.dispatchStartRun({ tenant: 'acme', workflow: 'wf', input: 1, runId: 'run-1' });
      await until(() => replies.length === 1);
      expect(received[0]).toEqual({ tenant: 'acme', workflow: 'wf', input: 1, runId: 'run-1' });
      expect(replies[0]).toEqual({
        requestId: 'run-1',
        result: { ok: true, data: { runId: 'run-1', status: 'pending' } },
      });
    });

    it('two requesters never receive (or steal) each other’s replies', async () => {
      const adapter = new MockAdapter();
      const a = make(adapter, { instanceId: 'pod-a' });
      const b = make(adapter, { instanceId: 'pod-b' });
      const cp = make(adapter, { instanceId: 'cp' });
      cp.onRunRequest(async (msg: RunRequest) => {
        await cp.publishRunReply({
          requestId: msg.requestId,
          result: { ok: true, data: msg.requestId },
        });
      });
      const gotA: string[] = [];
      const gotB: string[] = [];
      a.onRunReply((r) => gotA.push(r.requestId));
      b.onRunReply((r) => gotB.push(r.requestId));

      for (let i = 0; i < 5; i += 1) {
        await a.dispatchRunRequest({
          requestId: `a${i}`,
          tenant: 'acme',
          body: { kind: 'workerHealth' },
        });
        await b.dispatchRunRequest({
          requestId: `b${i}`,
          tenant: 'acme',
          body: { kind: 'workerHealth' },
        });
      }
      await until(() => gotA.length === 5 && gotB.length === 5);
      await sleep(30);
      expect(gotA).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
      expect(gotB).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    });

    it('replies ride the requester’s own inbox queue', async () => {
      const adapter = new MockAdapter();
      const tenant = make(adapter, { instanceId: 'pod-a' });
      const cp = make(adapter);
      // The requester never consumes in this test: park its inbox by not subscribing, then look.
      const pushed = vi.spyOn(adapter, 'pushOn');
      cp.onRunRequest(async (msg) => {
        await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: null } });
      });
      await tenant.dispatchRunRequest({
        requestId: 'q1',
        tenant: 'acme',
        body: { kind: 'workerHealth' },
      });
      await until(() => pushed.mock.calls.some(([q]) => q === runRepliesQueue('durable', 'pod-a')));
    });

    it('a reply with no known requester is dropped and reported, never broadcast', async () => {
      const adapter = new MockAdapter();
      const errors: unknown[] = [];
      const cp = make(adapter, { onError: (e) => errors.push(e) });
      const pushed = vi.spyOn(adapter, 'pushOn');
      await cp.publishRunReply({ requestId: 'nobody', result: { ok: true, data: null } });
      expect(pushed).not.toHaveBeenCalled();
      expect(String(errors[0])).toContain('no requester is known');
    });

    it('a deferred transport parks the run-request consumer but still consumes its own reply inbox', async () => {
      const adapter = new MockAdapter();
      const deferredCp = make(adapter);
      deferredCp.deferConsumers();
      const handled: string[] = [];
      deferredCp.onRunRequest(async (msg) => void handled.push(msg.requestId));

      const tenant = make(adapter);
      tenant.deferConsumers();
      const replies: string[] = [];
      tenant.onRunReply((r) => replies.push(r.requestId));
      const liveCp = make(adapter);
      liveCp.onRunRequest(async (msg) => {
        await liveCp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: 1 } });
      });

      await tenant.dispatchRunRequest({
        requestId: 'q1',
        tenant: 'acme',
        body: { kind: 'workerHealth' },
      });
      await until(() => replies.length === 1);
      expect(handled).toEqual([]);
    });
  });

  describe('tenant events (fan-out to every live subscriber)', () => {
    /** A control plane: the responder's consumers start the registration recorder. */
    const controlPlane = (
      adapter: MockAdapter,
      keys: MemoryWorkerKeys | undefined,
      opts: Partial<QueueTransportOptions> = {},
    ) => {
      const cp = make(adapter, { ...(keys ? { workerKeys: keys } : {}), ...opts });
      cp.onRunRequest(async () => {});
      cp.onStartRun(async () => {});
      return cp;
    };
    /** Wait until `cond` (async) holds. */
    const eventually = async (cond: () => Promise<boolean>, budgetMs = 1500) => {
      const at = Date.now();
      while (!(await cond())) {
        if (Date.now() - at > budgetMs) throw new Error('timed out waiting for condition');
        await sleep(2);
      }
    };
    /** Wait until the control plane recorded `instanceId`'s subscription to `tenant`. */
    const recorded = (
      keys: MemoryWorkerKeys,
      tenant: string,
      instanceId: string,
      prefix = 'durable',
    ) =>
      eventually(async () =>
        (await keys.live(Date.now())).some(
          (k) => k.key === tenantSubscriberKey(prefix, tenant, instanceId),
        ),
      );
    const liveKeys = async (keys: MemoryWorkerKeys) =>
      (await keys.live(Date.now())).map((k) => k.key).sort();
    const eventPushes = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([q]) => String(q).includes(':tenant-events:'));

    it('reach every subscriber of the tenant, and no subscriber of another tenant — subscribers need no store', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      // Store-less subscribers: no workerKeys on these transports at all.
      const s1 = make(adapter, { instanceId: 's1' });
      const s2 = make(adapter, { instanceId: 's2' });
      const s3 = make(adapter, { instanceId: 's3' });
      const got1: TenantEvent[] = [];
      const got2: TenantEvent[] = [];
      const got3: TenantEvent[] = [];
      s1.onTenantEvent('acme', (e) => got1.push(e));
      s2.onTenantEvent('acme', (e) => got2.push(e));
      s3.onTenantEvent('globex', (e) => got3.push(e));
      await recorded(keys, 'acme', 's1');
      await recorded(keys, 'acme', 's2');
      await recorded(keys, 'globex', 's3');

      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
      await cp.publishTenantEvent({ tenant: 'globex', event: event('r2', 1) });
      await until(() => got1.length === 1 && got2.length === 1 && got3.length === 1);
      await sleep(30);
      expect(got1.map((e) => e.event.runId)).toEqual(['r1']);
      expect(got2.map((e) => e.event.runId)).toEqual(['r1']);
      expect(got3.map((e) => e.event.runId)).toEqual(['r2']);
    });

    it('a subscriber receives one publisher’s events in publish order', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      const sub = make(adapter, { instanceId: 'pod' });
      const got: number[] = [];
      sub.onTenantEvent('acme', (e) => got.push((e.event as unknown as { seq: number }).seq));
      await recorded(keys, 'acme', 'pod');
      // Fired without awaiting each one — the transport serializes them.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) }),
        ),
      );
      await until(() => got.length === 20);
      expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    it('several handlers for one tenant on one instance each get the event, from ONE copy', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      const sub = make(adapter, { instanceId: 'pod' });
      const a: string[] = [];
      const b: string[] = [];
      sub.onTenantEvent('acme', (e) => a.push(e.event.runId));
      sub.onTenantEvent('acme', (e) => b.push(e.event.runId));
      await recorded(keys, 'acme', 'pod');
      const pushed = vi.spyOn(adapter, 'pushOn');
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
      await until(() => a.length === 1 && b.length === 1);
      expect(eventPushes(pushed)).toHaveLength(1);
    });

    it('unsubscribe stops delivery and withdraws the subscription once the last handler leaves', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      const sub = make(adapter, { instanceId: 'pod' });
      const a: string[] = [];
      const b: string[] = [];
      const offA = sub.onTenantEvent('acme', (e) => a.push(e.event.runId));
      const offB = sub.onTenantEvent('acme', (e) => b.push(e.event.runId));
      await recorded(keys, 'acme', 'pod');
      const key = tenantSubscriberKey('durable', 'acme', 'pod');

      offA();
      await sleep(30);
      expect(await liveKeys(keys)).toContain(key);
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
      await until(() => b.length === 1);
      expect(a).toEqual([]);

      offB();
      await eventually(async () => !(await liveKeys(keys)).includes(key));
      const pushed = vi.spyOn(adapter, 'pushOn');
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 2) });
      expect(eventPushes(pushed)).toEqual([]);
      await sleep(30);
      expect(b).toEqual(['r1']);
    });

    it('a tenant name cannot match another tenant’s subscriber keys (`:` in names)', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      const sub = make(adapter, { instanceId: 'pod' });
      sub.onTenantEvent('a:b', () => {});
      await recorded(keys, 'a:b', 'pod');
      const pushed = vi.spyOn(adapter, 'pushOn');
      await cp.publishTenantEvent({ tenant: 'a', event: event('r1', 1) });
      expect(eventPushes(pushed)).toEqual([]);
    });

    it('a malformed registration is ignored', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      controlPlane(adapter, keys);
      for (const payload of [
        null,
        { instanceId: 'x' },
        { instanceId: 'x', ttlMs: 10, inbox: true, tenants: [1] },
      ]) {
        await adapter.pushOn('durable:inbox-registrations', {
          id: crypto.randomUUID(),
          name: 'inboxRegistration',
          payload,
          attempts: 0,
          createdAt: Date.now(),
        });
      }
      await until(() => (adapter.pending.get('durable:inbox-registrations')?.length ?? 0) === 0);
      await sleep(20);
      expect(await liveKeys(keys)).toEqual([]);
    });

    it('a dead subscriber stops receiving pushes once its keys expire, and the janitor drains its inbox', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys, { inboxTtlMs: 60, inboxSweepIntervalMs: 20 });
      // A pod that subscribed and then crashed: its last announcement was recorded, nothing consumes
      // its inbox, and it never re-announces.
      await adapter.pushOn('durable:inbox-registrations', {
        id: 'reg-1',
        name: 'inboxRegistration',
        payload: { instanceId: 'ghost', ttlMs: 60, inbox: true, tenants: ['acme'] },
        attempts: 0,
        createdAt: Date.now(),
      });
      await recorded(keys, 'acme', 'ghost');
      const ghostInbox = tenantEventsQueue('durable', 'ghost');

      for (let i = 0; i < 3; i += 1) {
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
      }
      expect(await adapter.sizeOf(ghostInbox)).toBe(3);

      await sleep(80); // the keys expire
      const pushed = vi.spyOn(adapter, 'pushOn');
      for (let i = 3; i < 6; i += 1) {
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
      }
      // No longer pushed to …
      expect(pushed.mock.calls.filter(([q]) => q === ghostInbox)).toEqual([]);
      // … and what was pushed while it looked alive is drained.
      await until(() => (adapter.pending.get(ghostInbox)?.length ?? 0) === 0, 2000);
      expect(adapter.active.size).toBe(0);
    });

    it('the janitor leaves a LIVE subscriber’s inbox alone', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys, { inboxTtlMs: 60, inboxSweepIntervalMs: 20 });
      const sub = make(adapter, { instanceId: 'pod', inboxTtlMs: 60 });
      const got: number[] = [];
      sub.onTenantEvent('acme', (e) => got.push((e.event as unknown as { seq: number }).seq));
      await recorded(keys, 'acme', 'pod');
      for (let i = 0; i < 3; i += 1) {
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
      }
      await sleep(150); // several TTLs and sweeps: the subscriber keeps re-announcing
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 3) });
      await until(() => got.length === 4);
      expect(got).toEqual([0, 1, 2, 3]);
    });

    it('a dead REQUESTER’s unconsumed reply is drained too', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = make(adapter, { workerKeys: keys, inboxTtlMs: 40, inboxSweepIntervalMs: 20 });
      cp.onRunRequest(async (msg) => {
        await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: 1 } });
      });
      // A requester that pushes a request and dies before the reply: modelled by pushing the wire job
      // directly, with nobody consuming `ghost`'s inbox.
      await adapter.pushOn('durable:run-request', {
        id: 'j1',
        name: 'runRequest',
        payload: {
          requestId: 'q1',
          tenant: 'acme',
          body: { kind: 'workerHealth' },
          replyTo: 'ghost',
        },
        attempts: 0,
        createdAt: Date.now(),
      });
      const ghostInbox = runRepliesQueue('durable', 'ghost');
      await until(() => (adapter.pending.get(ghostInbox)?.length ?? 0) === 1);
      await until(() => (adapter.pending.get(ghostInbox)?.length ?? 0) === 0, 2000);
    });

    it('a LIVE requester (re-announcing its inbox) keeps its replies even after a TTL', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = make(adapter, { workerKeys: keys, inboxTtlMs: 40, inboxSweepIntervalMs: 10 });
      cp.onRunRequest(async (msg) => {
        await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: 1 } });
      });
      const tenant = make(adapter, { instanceId: 'pod', inboxTtlMs: 40 });
      const got: string[] = [];
      tenant.onRunReply((r) => got.push(r.requestId));
      for (let i = 0; i < 4; i += 1) {
        await tenant.dispatchRunRequest({
          requestId: `q${i}`,
          tenant: 'acme',
          body: { kind: 'workerHealth' },
        });
        await sleep(30);
      }
      await until(() => got.length === 4);
      expect(got).toEqual(['q0', 'q1', 'q2', 'q3']);
    });

    it('close() withdraws the subscription and inbox, and empties its own inbox', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys);
      const sub = new QueueTransport({
        adapter: () => adapter,
        pollIntervalMs: 1_000, // slow: the event is still queued when close() runs
        stalledCheckIntervalMs: 0,
        instanceId: 'pod',
      });
      sub.onTenantEvent('acme', () => {});
      await recorded(keys, 'acme', 'pod');
      expect(await liveKeys(keys)).toEqual(
        [inboxKey('durable', 'pod'), tenantSubscriberKey('durable', 'acme', 'pod')].sort(),
      );
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
      await sub.close();
      expect(adapter.pending.get(tenantEventsQueue('durable', 'pod'))?.length ?? 0).toBe(0);
      await eventually(async () => (await liveKeys(keys)).length === 0);
    });

    it('a control plane without a worker-key store reports that subscriptions cannot be recorded', async () => {
      const adapter = new MockAdapter();
      const errors: unknown[] = [];
      controlPlane(adapter, undefined, { onError: (e) => errors.push(e) });
      const sub = make(adapter);
      sub.onTenantEvent('acme', () => {});
      await until(() => errors.length > 0);
      expect(String(errors[0])).toContain('no worker-key store');
    });

    it('namespace folding applies to the inbox queues, registrations and keys', async () => {
      const adapter = new MockAdapter();
      const keys = new MemoryWorkerKeys();
      const cp = controlPlane(adapter, keys, { namespace: 'staging' });
      const other = controlPlane(adapter, keys);
      const sub = make(adapter, { instanceId: 'pod', namespace: 'staging' });
      const got: string[] = [];
      sub.onTenantEvent('acme', (e) => got.push(e.event.runId));
      await recorded(keys, 'acme', 'pod', 'durable-staging');
      await other.publishTenantEvent({ tenant: 'acme', event: event('wrong-ns', 1) });
      await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
      await until(() => got.length === 1);
      await sleep(30);
      expect(got).toEqual(['r1']);
    });
  });
});

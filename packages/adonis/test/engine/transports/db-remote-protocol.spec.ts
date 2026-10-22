import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EngineEvent,
  RemoteTask,
  RunReply,
  StartRunMessage,
  StepResult,
  TenantEvent,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../../src/interfaces.js';
import { hasProxyCapability, hasResponderCapability } from '../../../src/role_bindings.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { DbTransport, type DbTransportOptions } from '../../../src/transports/db.js';
import { TRANSPORT_TABLES } from '../../../src/transports/db-schema.js';
import { inboxKey, tenantSubscriberKey } from '../../../src/transports/queue-remote.js';
import { lucidWorkerKeys } from '../../../src/transports/worker-keys-db.js';
import { RedisWorkerRegistry } from '../../../src/worker-runtime/registry.js';
import { WorkerRuntime } from '../../../src/worker-runtime/worker-runtime.js';
import { dbBackends } from '../../support/backends.js';

/**
 * The parts of the store-less protocol the db transport carries, mirroring the queue transport's
 * protocol spec: remote workflow turns (task row → decision), streamed step events, start-run and
 * run-request, run replies (to the requester only) and tenant events (to every live subscriber of the
 * tenant). Everything rides the shared database: the messages table, and the worker-key table for
 * the subscriber registry.
 */

const POLL = 5;
const M = TRANSPORT_TABLES.messages;

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 3));
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

const completed = (task: WorkflowTask): WorkflowDecision => ({
  taskId: task.taskId,
  runId: task.runId,
  status: 'completed',
  commands: [],
});

describe.each(dbBackends())('on $name', ({ makeMemoryDb, makeTransportDb }) => {
  describe('DbTransport — store-less protocol and remote workflows', () => {
    const cleanups: Array<() => Promise<void>> = [];
    let db: Database;

    afterEach(async () => {
      for (const c of cleanups.splice(0).reverse()) await c();
    });

    async function freshDb(): Promise<Database> {
      db = await makeTransportDb();
      cleanups.push(() => db.manager.closeAll());
      return db;
    }

    const make = (opts: Partial<DbTransportOptions> = {}) => {
      const t = new DbTransport({
        db,
        pollIntervalMs: POLL,
        tenantSubscribersCacheMs: 0,
        ...opts,
      });
      cleanups.push(() => t.close());
      return t;
    };

    const rows = (where: Record<string, string> = {}) =>
      db.connection().from(M).where(where).select('*') as Promise<Array<Record<string, unknown>>>;
    const liveKeys = async () =>
      (await lucidWorkerKeys(db).live(Date.now())).map((k) => k.key).sort();
    const recorded = (tenant: string, instanceId: string, prefix = 'durable') =>
      until(async () =>
        (await liveKeys()).includes(tenantSubscriberKey(prefix, tenant, instanceId)),
      );

    it('exposes every store-less protocol method the provider feature-detects', async () => {
      await freshDb();
      const t = make();
      expect(hasProxyCapability(t)).toBe(true);
      expect(hasResponderCapability(t)).toBe(true);
      expect(typeof t.dispatchWorkflowTask).toBe('function');
      expect(typeof t.handleWorkflow).toBe('function');
      expect(typeof t.onDecision).toBe('function');
      expect(typeof t.dispatchStepEvent).toBe('function');
      expect(typeof t.onStepEvent).toBe('function');
    });

    describe('remote workflow turns', () => {
      it('dispatchWorkflowTask → handleWorkflow turn → decision reaches onDecision', async () => {
        await freshDb();
        const engine = make();
        const worker = make();
        const decisions: WorkflowDecision[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        const seen: WorkflowTask[] = [];
        worker.handleWorkflow('pipeline', async (task) => {
          seen.push(task);
          return completed(task);
        });

        await engine.dispatchWorkflowTask(workflowTask());
        await until(() => decisions.length === 1);
        // The turn gets the task as dispatched — the reply target is stripped.
        expect(seen[0]).toEqual(workflowTask());
        expect(decisions[0]).toEqual({
          taskId: 'r1:wf:1',
          runId: 'r1',
          status: 'completed',
          commands: [],
        });
        await until(async () => (await rows()).length === 0);
        expect(await db.connection().from(TRANSPORT_TABLES.tasks)).toEqual([]);
      });

      it('the turn is a `workflow` task row on the routing token, by priority', async () => {
        await freshDb();
        const engine = make();
        await engine.dispatchWorkflowTask(workflowTask({ group: 'pipeline@acme', priority: 7 }));
        const [row] = await db.connection().from(TRANSPORT_TABLES.tasks);
        expect(row).toMatchObject({
          step_id: 'r1:wf:1',
          kind: 'workflow',
          grp: 'pipeline@acme',
          name: 'pipeline',
          priority: 7,
        });
        // Idempotent per taskId.
        await engine.dispatchWorkflowTask(workflowTask({ group: 'pipeline@acme', priority: 7 }));
        expect(await db.connection().from(TRANSPORT_TABLES.tasks)).toHaveLength(1);
      });

      it('a step and a workflow turn on the SAME token are told apart by kind', async () => {
        await freshDb();
        const engine = make();
        const worker = make();
        const decisions: WorkflowDecision[] = [];
        const results: StepResult[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        engine.onResult(async (r) => void results.push(r));
        worker.handle('pipeline', async () => 'step-ran');
        worker.handleWorkflow('pipeline', async (task) => completed(task));

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
        await freshDb();
        const engine = make();
        const worker = make();
        const decisions: WorkflowDecision[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        worker.handle('pipeline', async () => 'x'); // the token is served, the workflow is not
        await engine.dispatchWorkflowTask(workflowTask());
        await until(() => decisions.length === 1);
        expect(decisions[0]).toMatchObject({ status: 'failed', error: { code: 'no_workflow' } });
      });

      it('a throwing turn still yields a failed decision', async () => {
        await freshDb();
        const errors: unknown[] = [];
        const engine = make();
        const worker = make({ onError: (e) => errors.push(e) });
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
        await freshDb();
        const engine = make();
        const worker = make();
        const a: string[] = [];
        const b: string[] = [];
        engine.onDecision(async (d) => void a.push(d.taskId));
        engine.onDecision(async (d) => void b.push(d.taskId));
        worker.handleWorkflow('pipeline', async (task) => completed(task));
        await engine.dispatchWorkflowTask(workflowTask());
        await until(() => a.length === 1 && b.length === 1);
        expect(a).toEqual(['r1:wf:1']);
        expect(b).toEqual(['r1:wf:1']);
      });

      it('a decision returns to the engine replica that dispatched the turn, never a sibling', async () => {
        await freshDb();
        const e1 = make({ instanceId: 'engine-1' });
        const e2 = make({ instanceId: 'engine-2' });
        const worker = make();
        const got1: string[] = [];
        const got2: string[] = [];
        e1.onDecision(async (d) => void got1.push(d.taskId));
        e2.onDecision(async (d) => void got2.push(d.taskId));
        worker.handleWorkflow('pipeline', async (task) => completed(task));
        for (let i = 0; i < 5; i += 1) {
          await e1.dispatchWorkflowTask(workflowTask({ taskId: `a${i}`, runId: `ra${i}` }));
          await e2.dispatchWorkflowTask(workflowTask({ taskId: `b${i}`, runId: `rb${i}` }));
        }
        await until(() => got1.length === 5 && got2.length === 5);
        await sleep(30);
        expect(got1.sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
        expect(got2.sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
      });

      it('a deferred engine still consumes the decisions addressed to it, but no unaddressed one', async () => {
        await freshDb();
        const engine = make({ instanceId: 'engine' });
        engine.deferConsumers();
        const got: string[] = [];
        engine.onDecision(async (d) => void got.push(d.taskId));
        const worker = make();
        worker.handleWorkflow('pipeline', async (task) => completed(task));
        await engine.dispatchWorkflowTask(workflowTask());
        await until(() => got.length === 1);
        // A decision nobody was named for (a foreign worker): left for a consuming engine …
        await db
          .connection()
          .table(M)
          .insert({
            kind: 'decision',
            namespace: 'default',
            recipient: '',
            payload: JSON.stringify(completed(workflowTask({ taskId: 'orphan' }))),
            created_at: Date.now(),
          });
        await sleep(40);
        expect(got).toEqual(['r1:wf:1']);
        // … which this one becomes on startConsumers().
        engine.startConsumers();
        await until(() => got.length === 2);
        expect(got).toEqual(['r1:wf:1', 'orphan']);
      });

      it('a workflow row past the poison bound is dropped, without a decision', async () => {
        await freshDb();
        const errors: unknown[] = [];
        const engine = make();
        const decisions: WorkflowDecision[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        await engine.dispatchWorkflowTask(workflowTask());
        await db.connection().from(TRANSPORT_TABLES.tasks).update({ reclaims: 4 });
        let ran = false;
        make({ onError: (e) => errors.push(e) }).handleWorkflow('pipeline', async (task) => {
          ran = true;
          return completed(task);
        });
        await until(async () => (await db.connection().from(TRANSPORT_TABLES.tasks)).length === 0);
        await sleep(30);
        expect(ran).toBe(false);
        expect(decisions).toEqual([]);
        expect(String(errors[0])).toContain('lapsed more than 3 times');
      });

      it('step events are point-to-point: two engines checkpoint each event once in total', async () => {
        await freshDb();
        const worker = make();
        const e1 = make();
        const e2 = make();
        const got: WorkflowStepEvent[] = [];
        e1.onStepEvent(async (e) => void got.push(e));
        e2.onStepEvent(async (e) => void got.push(e));
        for (let seq = 1; seq <= 5; seq += 1) {
          await worker.dispatchStepEvent({
            runId: 'r1',
            seq,
            name: 'side',
            phase: 'completed',
            startedAt: 0,
          });
        }
        await until(() => got.length === 5);
        await sleep(30);
        expect(got.map((e) => e.seq).sort()).toEqual([1, 2, 3, 4, 5]);
      });

      it('a deferred engine parks the step-event consumer', async () => {
        await freshDb();
        const engine = make();
        engine.deferConsumers();
        const got: number[] = [];
        engine.onStepEvent(async (e) => void got.push(e.seq));
        await make().dispatchStepEvent({
          runId: 'r1',
          seq: 1,
          name: 's',
          phase: 'running',
          startedAt: 0,
        });
        await sleep(40);
        expect(got).toEqual([]);
        engine.startConsumers();
        await until(() => got.length === 1);
      });
    });

    describe('start-run and run-request (to any control plane)', () => {
      it('a start-run reaches onStartRun as sent, and its reply comes back', async () => {
        await freshDb();
        const tenant = make();
        const cp = make();
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
        await until(async () => (await rows()).length === 0);
      });

      it('two requesters never receive (or steal) each other’s replies', async () => {
        await freshDb();
        const a = make({ instanceId: 'pod-a' });
        const b = make({ instanceId: 'pod-b' });
        const cp = make({ instanceId: 'cp' });
        cp.onRunRequest(async (msg) => {
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

      it('a reply is a row addressed to the requester', async () => {
        await freshDb();
        // The requester's own poll is slow, so the reply row is still there to look at.
        const tenant = make({ instanceId: 'pod-a', pollIntervalMs: 2_000 });
        const cp = make();
        cp.onRunRequest(async (msg) => {
          await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: null } });
        });
        await tenant.dispatchRunRequest({
          requestId: 'q1',
          tenant: 'acme',
          body: { kind: 'workerHealth' },
        });
        await until(async () => (await rows({ kind: 'runReply' })).length === 1);
        const [reply] = await rows({ kind: 'runReply' });
        expect(reply).toMatchObject({ recipient: 'pod-a' });
        expect(JSON.parse(String(reply?.payload))).toEqual({
          requestId: 'q1',
          result: { ok: true, data: null },
        });
      });

      it('a reply with no known requester is dropped and reported, never broadcast', async () => {
        await freshDb();
        const errors: unknown[] = [];
        const cp = make({ onError: (e) => errors.push(e) });
        await cp.publishRunReply({ requestId: 'nobody', result: { ok: true, data: null } });
        expect(await rows()).toEqual([]);
        expect(String(errors[0])).toContain('no requester is known');
      });

      it('a deferred transport parks the run-request consumer but still consumes its own replies', async () => {
        await freshDb();
        const deferredCp = make();
        deferredCp.deferConsumers();
        const handled: string[] = [];
        deferredCp.onRunRequest(async (msg) => void handled.push(msg.requestId));

        const tenant = make();
        tenant.deferConsumers();
        const replies: string[] = [];
        tenant.onRunReply((r) => replies.push(r.requestId));
        const liveCp = make();
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

      it('close() hands a request still being handled back, for another control plane at once', async () => {
        await freshDb();
        const tenant = make();
        const replies: string[] = [];
        tenant.onRunReply((r) => replies.push(r.requestId));
        const stuck = make({ instanceId: 'cp-1', closeTimeoutMs: 30, leaseMs: 60_000 });
        let startedOnStuck = false;
        stuck.onStartRun(async () => {
          startedOnStuck = true;
          await new Promise(() => {});
        });
        await tenant.dispatchStartRun({ tenant: 'acme', workflow: 'wf', input: 1, runId: 'run-1' });
        await until(() => startedOnStuck);
        await stuck.close();
        const [row] = await rows({ kind: 'startRun' });
        expect(row).toMatchObject({
          claimed_by: null,
          claimed_at: null,
          reply_to: tenant.instanceId,
        });

        const next = make({ instanceId: 'cp-2', leaseMs: 60_000 });
        next.onStartRun(async (msg) => {
          await next.publishRunReply({
            requestId: msg.runId as string,
            result: { ok: true, data: 1 },
          });
        });
        // Within a poll or two, not after the 60s lease.
        await until(() => replies.length === 1, 1_000);
        expect(replies).toEqual(['run-1']);
      });
    });

    describe('tenant events (one row per live subscriber)', () => {
      it('reach every subscriber of the tenant, and no subscriber of another tenant', async () => {
        await freshDb();
        const cp = make();
        const s1 = make({ instanceId: 's1' });
        const s2 = make({ instanceId: 's2' });
        const s3 = make({ instanceId: 's3' });
        const got1: TenantEvent[] = [];
        const got2: TenantEvent[] = [];
        const got3: TenantEvent[] = [];
        s1.onTenantEvent('acme', (e) => got1.push(e));
        s2.onTenantEvent('acme', (e) => got2.push(e));
        s3.onTenantEvent('globex', (e) => got3.push(e));
        await recorded('acme', 's1');
        await recorded('acme', 's2');
        await recorded('globex', 's3');

        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        await cp.publishTenantEvent({ tenant: 'globex', event: event('r2', 1) });
        await until(() => got1.length === 1 && got2.length === 1 && got3.length === 1);
        // A row is deleted once its handler ran, so the handler can be seen before the delete lands
        // (CI caught rows still claimed after a fixed 30ms beat): wait for the table to drain, then a
        // beat for a would-be extra delivery.
        await until(async () => (await rows()).length === 0);
        await sleep(30);
        expect(got1.map((e) => e.event.runId)).toEqual(['r1']);
        expect(got2.map((e) => e.event.runId)).toEqual(['r1']);
        expect(got3.map((e) => e.event.runId)).toEqual(['r2']);
        expect(await rows()).toEqual([]);
      });

      it('a subscriber receives one publisher’s events in publish order', async () => {
        await freshDb();
        const cp = make();
        const sub = make({ instanceId: 'pod' });
        const got: number[] = [];
        sub.onTenantEvent('acme', (e) => got.push((e.event as unknown as { seq: number }).seq));
        await recorded('acme', 'pod');
        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) }),
          ),
        );
        await until(() => got.length === 20);
        expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i));
      });

      it('several handlers for one tenant on one instance each get the event, from ONE row', async () => {
        await freshDb();
        const cp = make();
        const sub = make({ instanceId: 'pod', pollIntervalMs: 300, idleBackoffMax: 1 });
        const a: string[] = [];
        const b: string[] = [];
        sub.onTenantEvent('acme', (e) => a.push(e.event.runId));
        sub.onTenantEvent('acme', (e) => b.push(e.event.runId));
        await recorded('acme', 'pod');
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        expect(await rows({ kind: 'tenantEvent' })).toHaveLength(1);
        await until(() => a.length === 1 && b.length === 1);
      });

      it('unsubscribe stops delivery and removes the subscription once the last handler leaves', async () => {
        await freshDb();
        const cp = make();
        const sub = make({ instanceId: 'pod' });
        const a: string[] = [];
        const b: string[] = [];
        const offA = sub.onTenantEvent('acme', (e) => a.push(e.event.runId));
        const offB = sub.onTenantEvent('acme', (e) => b.push(e.event.runId));
        await recorded('acme', 'pod');
        const key = tenantSubscriberKey('durable', 'acme', 'pod');

        offA();
        await sleep(30);
        expect(await liveKeys()).toContain(key);
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        await until(() => b.length === 1);
        expect(a).toEqual([]);

        offB();
        await until(async () => !(await liveKeys()).includes(key));
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 2) });
        expect(await rows({ kind: 'tenantEvent' })).toEqual([]);
        await sleep(30);
        expect(b).toEqual(['r1']);
      });

      it('a tenant name cannot match another tenant’s subscriber keys (`:` in names)', async () => {
        await freshDb();
        const cp = make();
        const sub = make({ instanceId: 'pod', pollIntervalMs: 2_000 });
        sub.onTenantEvent('a:b', () => {});
        await recorded('a:b', 'pod');
        await cp.publishTenantEvent({ tenant: 'a', event: event('r1', 1) });
        expect(await rows()).toEqual([]);
      });

      it('a dead subscriber gets no rows once its keys expire, and the janitor deletes what it was sent', async () => {
        await freshDb();
        const cp = make({ inboxTtlMs: 60, inboxSweepIntervalMs: 20 });
        // A pod that subscribed and then crashed: its keys are there, nothing consumes its rows, and it
        // never refreshes them. Its keys stay live until the first publishes are seen addressed to it,
        // then are rewritten already expired — the state a crashed pod's keys reach on their own.
        // (A fixed 500ms lifetime raced the publishes on a loaded machine: the third found it gone.)
        const keys = lucidWorkerKeys(db);
        const value = JSON.stringify({ instanceId: 'ghost' });
        const ghostKeys = [
          inboxKey('durable', 'ghost'),
          tenantSubscriberKey('durable', 'acme', 'ghost'),
        ];
        for (const key of ghostKeys) await keys.put(key, value, Date.now() + 60_000);

        for (let i = 0; i < 3; i += 1) {
          await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
        }
        expect(await rows({ recipient: 'ghost' })).toHaveLength(3);

        // The keys expire.
        const expiresAt = Date.now();
        for (const key of ghostKeys) await keys.put(key, value, expiresAt);
        await sleep(20);
        for (let i = 3; i < 6; i += 1) {
          await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
        }
        // No longer addressed …
        const seqs = (await rows({ recipient: 'ghost' })).map(
          (r) => (JSON.parse(String(r.payload)) as { event: { seq: number } }).event.seq,
        );
        expect(seqs.every((seq) => seq < 3)).toBe(true);
        // … and what was addressed while it looked alive is deleted.
        await until(async () => (await rows({ recipient: 'ghost' })).length === 0);
        expect(await rows()).toEqual([]);
      });

      it('the janitor leaves a LIVE subscriber’s rows alone', async () => {
        await freshDb();
        // TTLs wide enough that a loaded machine refreshes the keys in time on a real database: the
        // refresh (every TTL / 3) shares a small pool with a janitor sweeping every 20ms.
        const cp = make({ inboxTtlMs: 600, inboxSweepIntervalMs: 20 });
        // Consumes slowly but keeps its keys fresh (every 200ms).
        const sub = make({
          instanceId: 'pod',
          inboxTtlMs: 600,
          pollIntervalMs: 5_000,
          idleBackoffMax: 1,
        });
        // The subscriber's message polls, seen as they COMPLETE (not as they are sent).
        let polled = 0;
        db.connection()
          .getWriteClient()
          .on('query-response', (_res: unknown, q: { sql: string; bindings?: unknown[] }) => {
            if (q.sql.startsWith('select') && q.sql.includes(M) && q.bindings?.includes('pod')) {
              polled += 1;
            }
          });
        const got: number[] = [];
        sub.onTenantEvent('acme', (e) => got.push((e.event as unknown as { seq: number }).seq));
        await recorded('acme', 'pod');
        // Its inbox key too — the janitor judges a recipient by that one.
        await until(async () => (await liveKeys()).includes(inboxKey('durable', 'pod')));
        await until(() => polled > 0); // its first (empty) poll is done; the next is 5s away
        for (let i = 0; i < 3; i += 1) {
          await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', i) });
        }
        await sleep(1_500); // several TTLs and sweeps
        expect(got).toEqual([]);
        expect(await rows({ recipient: 'pod' })).toHaveLength(3);
        await until(() => got.length === 3);
        expect(got).toEqual([0, 1, 2]);
      });

      it('a dead REQUESTER’s unconsumed reply is deleted too', async () => {
        await freshDb();
        const cp = make({ inboxTtlMs: 40, inboxSweepIntervalMs: 20 });
        cp.onRunRequest(async (msg) => {
          await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: 1 } });
        });
        // A requester that wrote its request and died before the reply: the wire row, inserted directly.
        await db
          .connection()
          .table(M)
          .insert({
            kind: 'runRequest',
            namespace: 'default',
            recipient: '',
            reply_to: 'ghost',
            payload: JSON.stringify({
              requestId: 'q1',
              tenant: 'acme',
              body: { kind: 'workerHealth' },
            }),
            created_at: Date.now(),
          });
        await until(async () => (await rows({ recipient: 'ghost' })).length === 1);
        await until(async () => (await rows()).length === 0);
      });

      it('a LIVE requester keeps its replies even after a TTL', async () => {
        await freshDb();
        const cp = make({ inboxTtlMs: 200, inboxSweepIntervalMs: 10 });
        cp.onRunRequest(async (msg) => {
          await cp.publishRunReply({ requestId: msg.requestId, result: { ok: true, data: 1 } });
        });
        const tenant = make({ instanceId: 'pod', inboxTtlMs: 200 });
        const got: string[] = [];
        tenant.onRunReply((r) => got.push(r.requestId));
        for (let i = 0; i < 4; i += 1) {
          await tenant.dispatchRunRequest({
            requestId: `q${i}`,
            tenant: 'acme',
            body: { kind: 'workerHealth' },
          });
          await sleep(80); // four of these outlast the TTL
        }
        await until(() => got.length === 4);
        expect(got).toEqual(['q0', 'q1', 'q2', 'q3']);
      });

      it('close() removes the subscription and inbox keys, and deletes the rows addressed to it', async () => {
        await freshDb();
        const cp = make();
        const sub = new DbTransport({ db, pollIntervalMs: 2_000, instanceId: 'pod' });
        sub.onTenantEvent('acme', () => {});
        await recorded('acme', 'pod');
        expect(await liveKeys()).toEqual(
          [inboxKey('durable', 'pod'), tenantSubscriberKey('durable', 'acme', 'pod')].sort(),
        );
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        expect(await rows({ recipient: 'pod' })).toHaveLength(1);
        await sub.close();
        expect(await rows({ recipient: 'pod' })).toEqual([]);
        expect(await liveKeys()).toEqual([]);
      });

      it('namespaces keep subscriptions and rows apart', async () => {
        await freshDb();
        const cp = make({ namespace: 'staging' });
        const other = make();
        const sub = make({ instanceId: 'pod', namespace: 'staging' });
        const got: string[] = [];
        sub.onTenantEvent('acme', (e) => got.push(e.event.runId));
        await recorded('acme', 'pod', 'durable-staging');
        await other.publishTenantEvent({ tenant: 'acme', event: event('wrong-ns', 1) });
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        await until(() => got.length === 1);
        await sleep(30);
        expect(got).toEqual(['r1']);
      });
    });

    describe('worker advertisement from a tenant pod', () => {
      it('is written straight to the shared table, so the control plane lists the pod’s workers', async () => {
        await freshDb();
        const cp = make({ workerKeysCacheMs: 0 });
        const pod = make({ instanceId: 'pod', partition: 'acme' });
        const runtime = new WorkerRuntime({
          transport: pod,
          partition: 'acme',
          instanceId: 'pod',
          registry: new RedisWorkerRegistry(pod.createDescriptorRedis(), { ownsConnection: true }),
        });
        runtime.handle('charge', async () => 'ok');
        runtime.registerWorkflow('flow', () => 'done');
        await runtime.start();

        await until(async () => (await cp.listWorkerGroups()).includes('charge@acme'));
        const [descriptor] = await cp.listWorkerDescriptors('flow@acme');
        expect(descriptor).toMatchObject({ steps: ['charge'], workflows: ['flow'] });
        await runtime.stop();
      });
    });

    describe('a deployment without the new schema', () => {
      async function legacyDb(): Promise<Database> {
        db = await makeMemoryDb();
        cleanups.push(() => db.manager.closeAll());
        // The tasks table as an earlier release created it — no `kind` column — and no messages table.
        await db.connection().schema.createTable(TRANSPORT_TABLES.tasks, (t) => {
          t.string('step_id').primary();
          t.string('run_id').notNullable();
          t.integer('seq').notNullable();
          t.string('name').notNullable();
          t.string('grp').notNullable();
          t.string('namespace').notNullable().defaultTo('default');
          t.text('input');
          t.string('traceparent');
          t.text('context');
          t.string('transport');
          t.integer('attempt').notNullable();
          t.integer('reclaims').notNullable().defaultTo(0);
          t.integer('priority').notNullable().defaultTo(0);
          t.string('claimed_by');
          t.bigInteger('claimed_at');
          t.bigInteger('created_at').notNullable();
        });
        return db;
      }

      it('reports the missing messages table ONCE, and requests fail fast instead of timing out', async () => {
        await legacyDb();
        const errors: unknown[] = [];
        const t = make({ autoCreate: false, onError: (e) => errors.push(e) });
        for (let i = 0; i < 3; i += 1) {
          await expect(
            t.dispatchRunRequest({
              requestId: `q${i}`,
              tenant: 'acme',
              body: { kind: 'workerHealth' },
            }),
          ).rejects.toThrow(/durable_transport_messages table does not exist/);
        }
        await t.dispatchStepEvent({
          runId: 'r',
          seq: 1,
          name: 's',
          phase: 'running',
          startedAt: 0,
        });
        await sleep(30);
        expect(errors.filter((e) => String(e).includes('durable_transport_messages'))).toHaveLength(
          1,
        );
      });

      it('a control plane that never uses the protocol hears nothing about it', async () => {
        await legacyDb();
        const errors: unknown[] = [];
        const cp = make({ autoCreate: false, onError: (e) => errors.push(e) });
        cp.onRunRequest(async () => {});
        cp.onStartRun(async () => {});
        cp.onStepEvent(async () => {});
        await cp.publishTenantEvent({ tenant: 'acme', event: event('r1', 1) });
        await sleep(40);
        expect(errors).toEqual([]);
      });

      it('dispatchWorkflowTask names the missing schema', async () => {
        await legacyDb();
        await db.connection().schema.createTable(TRANSPORT_TABLES.messages, (t) => {
          t.increments('id').primary();
          t.string('kind', 32).notNullable();
          t.string('namespace').notNullable().defaultTo('default');
          t.string('recipient').notNullable().defaultTo('');
          t.string('reply_to');
          t.text('payload').notNullable();
          t.string('claimed_by');
          t.bigInteger('claimed_at');
          t.bigInteger('created_at').notNullable();
        });
        const errors: unknown[] = [];
        const t = make({ autoCreate: false, onError: (e) => errors.push(e) });
        await expect(t.dispatchWorkflowTask(workflowTask())).rejects.toThrow(/no "kind" column/);
        expect(String(errors[0])).toContain('no "kind" column');
      });

      it('autoCreate adds the kind column and the messages table to a legacy schema', async () => {
        await legacyDb();
        const engine = make();
        const worker = make();
        const decisions: WorkflowDecision[] = [];
        engine.onDecision(async (d) => void decisions.push(d));
        worker.handleWorkflow('pipeline', async (task) => completed(task));
        await engine.dispatchWorkflowTask(workflowTask());
        await until(() => decisions.length === 1);
      });
    });
  });
});

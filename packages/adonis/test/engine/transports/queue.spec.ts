import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Heartbeat, RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport, toBrokerPriority } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

const POLL = 5;

/** Wait until `cond()` is true (poll loops are async) or fail after a budget. */
async function until(cond: () => boolean, budgetMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

// Routing is now BY HANDLER NAME: the dispatched task's `group` is the name's routing token
// (`sanitizeQueueToken(name)`), the same token `handle(name)` subscribes to. Default it from `name`
// so a round-trip test's dispatch lands on the worker's queue; an explicit `group` still overrides
// (for the queue-naming assertions).
const task = (over: Partial<RemoteTask> = {}): RemoteTask => {
  const name = over.name ?? 'ext.echo';
  return {
    runId: 'r1',
    seq: 1,
    name,
    stepId: 'r1:1',
    group: sanitizeQueueToken(name),
    input: { hello: 'world' },
    attempt: 1,
    ...over,
  };
};

describe('QueueTransport', () => {
  const transports: QueueTransport[] = [];
  const make = (a: MockAdapter, opts: Partial<{ group: string }> = {}) => {
    const t = new QueueTransport({ adapter: () => a, pollIntervalMs: POLL, ...opts });
    transports.push(t);
    return t;
  };

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    vi.restoreAllMocks();
  });

  it('dispatch → worker handler runs → result flows back to onResult', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async (input) => ({ echoed: input }));

    await engine.dispatch(task());

    await until(() => results.length === 1);
    const r = results[0]!;
    expect(r.status).toBe('completed');
    expect(r.output).toEqual({ echoed: { hello: 'world' } });
    expect(r.stepId).toBe('r1:1');
    expect(typeof r.startedAt).toBe('number');
  });

  it('a throwing handler produces a failed StepResult (not a lost job)', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async () => {
      throw new Error('boom');
    });

    await engine.dispatch(task());
    await until(() => results.length === 1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error?.message).toBe('boom');
  });

  it('an unknown step name fails with a no-handler result', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });
    // The worker serves `ext.echo` (subscribing to that name's queue). A task carrying a DIFFERENT
    // name but routed onto that same queue (group === the served token) has no matching handler →
    // the no-handler result path.
    worker.handle('ext.echo', async () => 1);

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    await engine.dispatch(task({ name: 'ext.other', group: sanitizeQueueToken('ext.echo') }));

    await until(() => results.length === 1);
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.error?.message).toContain('no handler');
  });

  it('routes tasks by group to the matching task queue', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    await engine.dispatch(task({ group: 'payments' }));
    expect(await adapter.sizeOf('durable:tasks:payments')).toBe(1);
    expect(await adapter.sizeOf('durable:tasks:ext')).toBe(0);
  });

  it('honours a custom prefix', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const t = new QueueTransport({ adapter: () => adapter, prefix: 'app', pollIntervalMs: POLL });
    transports.push(t);
    await t.dispatch(task({ group: 'ext' }));
    expect(await adapter.sizeOf('app:tasks:ext')).toBe(1);
  });

  it('heartbeats flow worker → engine', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const beats: Heartbeat[] = [];
    engine.onHeartbeat(async (b) => void beats.push(b));
    await worker.heartbeat({ runId: 'r1', seq: 1, stepId: 'r1:1', group: 'ext' });

    await until(() => beats.length === 1);
    expect(beats[0]).toEqual({ runId: 'r1', seq: 1, stepId: 'r1:1', group: 'ext' });
  });

  it('control messages round-trip and stamp `from` with the instance id', async () => {
    const adapter = new MockAdapter();
    const pub = make(adapter);
    const sub = make(adapter);

    const got: any[] = [];
    sub.onControl((m) => got.push(m));
    await pub.publishControl({ kind: 'cancel', runId: 'r1' });

    await until(() => got.length === 1);
    expect(got[0]).toEqual({ kind: 'cancel', runId: 'r1', from: pub.instanceId });
  });

  it('handle() subscribes per handler name without needing a group option', () => {
    // Routing is by name now — a worker no longer declares a group to register handlers.
    const engine = make(new MockAdapter());
    expect(() => engine.handle('x', async () => 1)).not.toThrow();
  });

  it('close() stops loops and destroys the adapter', async () => {
    const adapter = new MockAdapter();
    const t = new QueueTransport({ adapter: () => adapter, group: 'ext', pollIntervalMs: POLL });
    t.handle('ext.echo', async () => 1);
    t.onResult(async () => {});
    await t.close();
    expect(adapter.destroyed).toBe(true);
  });

  it('toBrokerPriority inverts the engine convention (higher wins → lower broker number)', () => {
    // Absent priority leaves the default FIFO path untouched.
    expect(toBrokerPriority(undefined)).toBeUndefined();
    // Higher engine priority maps to a lower (more urgent) broker number, around the default baseline.
    expect(toBrokerPriority(0)).toBe(5);
    expect(toBrokerPriority(4)).toBe(1);
    expect(toBrokerPriority(-4)).toBe(9);
    // Clamped into the adapter's valid 1..10 range.
    expect(toBrokerPriority(100)).toBe(1);
    expect(toBrokerPriority(-100)).toBe(10);
  });

  it('a higher-priority task is dispatched ahead of a lower-priority one through the queue', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);

    // Enqueue a low-priority task FIRST, then a high-priority one — FIFO would run them in arrival
    // order; priority ordering must surface the urgent one first.
    await engine.dispatch(task({ stepId: 'r1:low', priority: 1 }));
    await engine.dispatch(task({ stepId: 'r1:high', priority: 9 }));

    const queue = 'durable:tasks:ext.echo';
    const first = await adapter.popFrom(queue);
    const second = await adapter.popFrom(queue);
    expect((first!.payload as RemoteTask).stepId).toBe('r1:high');
    expect((second!.payload as RemoteTask).stepId).toBe('r1:low');
  });

  describe('namespace queue segmentation', () => {
    it('default namespace keeps queue names BYTE-IDENTICAL to the un-namespaced scheme', async () => {
      const adapter = new MockAdapter();
      const t = new QueueTransport({
        adapter: () => adapter,
        namespace: 'default',
        pollIntervalMs: POLL,
      });
      transports.push(t);
      await t.dispatch(task({ group: 'ext' }));
      // Exactly the same queue name as a transport with no namespace at all.
      expect(await adapter.sizeOf('durable:tasks:ext')).toBe(1);
    });

    it('a non-default namespace folds into the prefix as `-<namespace>`', async () => {
      const adapter = new MockAdapter();
      const t = new QueueTransport({
        adapter: () => adapter,
        namespace: 'tenant-a',
        pollIntervalMs: POLL,
      });
      transports.push(t);
      await t.dispatch(task({ group: 'ext' }));
      expect(await adapter.sizeOf('durable-tenant-a:tasks:ext')).toBe(1);
      expect(await adapter.sizeOf('durable:tasks:ext')).toBe(0); // never touches the default queue
    });

    it('useNamespace() adopts a namespace when none was passed explicitly', async () => {
      const adapter = new MockAdapter();
      const t = new QueueTransport({ adapter: () => adapter, pollIntervalMs: POLL });
      transports.push(t);
      t.useNamespace('tenant-b');
      await t.dispatch(task({ group: 'ext' }));
      expect(await adapter.sizeOf('durable-tenant-b:tasks:ext')).toBe(1);
    });

    it('useNamespace("default") is a no-op (names stay byte-identical)', async () => {
      const adapter = new MockAdapter();
      const t = new QueueTransport({ adapter: () => adapter, pollIntervalMs: POLL });
      transports.push(t);
      t.useNamespace('default');
      await t.dispatch(task({ group: 'ext' }));
      expect(await adapter.sizeOf('durable:tasks:ext')).toBe(1);
    });

    it('an explicit constructor namespace WINS over a later useNamespace()', async () => {
      const adapter = new MockAdapter();
      const t = new QueueTransport({
        adapter: () => adapter,
        namespace: 'tenant-a',
        pollIntervalMs: POLL,
      });
      transports.push(t);
      t.useNamespace('tenant-b'); // ignored — explicit wins
      await t.dispatch(task({ group: 'ext' }));
      expect(await adapter.sizeOf('durable-tenant-a:tasks:ext')).toBe(1);
      expect(await adapter.sizeOf('durable-tenant-b:tasks:ext')).toBe(0);
    });

    it('two namespaces over ONE backend do not cross-deliver (results stay segmented too)', async () => {
      const adapter = new MockAdapter();
      const alphaEngine = new QueueTransport({
        adapter: () => adapter,
        namespace: 'alpha',
        pollIntervalMs: POLL,
      });
      const alphaWorker = new QueueTransport({
        adapter: () => adapter,
        namespace: 'alpha',
        group: 'ext',
        pollIntervalMs: POLL,
      });
      const betaWorker = new QueueTransport({
        adapter: () => adapter,
        namespace: 'beta',
        group: 'ext',
        pollIntervalMs: POLL,
      });
      transports.push(alphaEngine, alphaWorker, betaWorker);

      const alphaResults: StepResult[] = [];
      const betaSeen: string[] = [];
      alphaEngine.onResult(async (r) => void alphaResults.push(r));
      alphaWorker.handle('ext.echo', async (input) => ({ from: 'alpha', input }));
      betaWorker.handle('ext.echo', async () => {
        betaSeen.push('beta'); // must NEVER run for an alpha-dispatched task
        return { from: 'beta' };
      });

      await alphaEngine.dispatch(task({ name: 'ext.echo' }));
      await until(() => alphaResults.length === 1);

      expect(alphaResults[0]!.output).toEqual({ from: 'alpha', input: { hello: 'world' } });
      expect(betaSeen).toEqual([]); // beta's worker never saw alpha's task
    });
  });

  it('serializes payloads as JSON (functions dropped on the wire)', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const worker = make(adapter, { group: 'ext' });

    const seen: unknown[] = [];
    engine.onResult(async () => {});
    worker.handle('ext.echo', async (input) => {
      seen.push(input);
      return 'ok';
    });
    await engine.dispatch(task({ input: { keep: 1, fn: (() => 1) as any } }));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ keep: 1 });
  });

  describe('deferred consumers', () => {
    /** Enough real time for a POLL-interval loop to have claimed a ready job, had one been running. */
    const settle = () => new Promise((r) => setTimeout(r, POLL * 10));

    it('a deferred transport never claims tasks or results until startConsumers()', async () => {
      const adapter = new MockAdapter();
      const producer = make(adapter);
      const deferred = make(adapter);
      deferred.deferConsumers();

      const results: StepResult[] = [];
      const handled: unknown[] = [];
      deferred.onResult(async (r) => void results.push(r));
      deferred.handle('ext.echo', async (input) => {
        handled.push(input);
        return 'ok';
      });

      await producer.dispatch(task());
      await adapter.pushOn('durable:results', {
        id: 'res-1',
        name: 'result',
        attempts: 0,
        payload: JSON.stringify({ stepId: 'r9:1', status: 'completed', output: 1 }),
      });

      // The jobs sit on their queues — a pure producer claims nothing.
      await settle();
      expect(handled).toEqual([]);
      expect(results).toEqual([]);
      expect(await adapter.sizeOf(`durable:tasks:${sanitizeQueueToken('ext.echo')}`)).toBe(1);
      expect(await adapter.sizeOf('durable:results')).toBe(1);

      // The explicit "this process IS a worker" declaration flushes every parked loop: the task is
      // handled AND its round-trip result joins the seeded one on the results consumer.
      deferred.startConsumers();
      await until(() => handled.length === 1 && results.length === 2);
    });

    it('a subscription made AFTER startConsumers() consumes eagerly again', async () => {
      const adapter = new MockAdapter();
      const t = make(adapter);
      t.deferConsumers();
      t.startConsumers();

      const handled: unknown[] = [];
      t.handle('ext.echo', async (input) => {
        handled.push(input);
        return 'ok';
      });
      await t.dispatch(task());
      await until(() => handled.length === 1);
    });

    it('a parked loop stopped before the flush never starts', async () => {
      const adapter = new MockAdapter();
      const t = make(adapter);
      t.deferConsumers();

      const results: StepResult[] = [];
      t.onResult(async (r) => void results.push(r));
      // A transport closed while its loops were still parked: flushing afterwards must not
      // resurrect consumption on a closed transport.
      await t.close();
      t.startConsumers();

      await adapter.pushOn('durable:results', {
        id: 'res-2',
        name: 'result',
        attempts: 0,
        payload: JSON.stringify({ stepId: 'r9:2', status: 'completed', output: 1 }),
      });
      await settle();
      expect(results).toEqual([]);
    });
  });
});

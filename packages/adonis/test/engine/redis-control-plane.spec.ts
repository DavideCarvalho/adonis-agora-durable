import { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Cross-pod fan-out of the {@link RedisControlPlane}, run against a REAL Redis (set REDIS_URL, e.g.
 * `redis://127.0.0.1:6399`). Self-skips when REDIS_URL is unset so the default suite stays green
 * without a server — same gating as the Redis admission specs. Two engines share one Redis (distinct
 * instanceIds) standing in for two pods: a worker that runs the workflow and an API/dashboard that
 * only observes. Covers cross-pod cancel, lifecycle-event fan-out (with `from` dedupe), and that a
 * malformed payload on the channel is ignored.
 */
const REDIS_URL = process.env.REDIS_URL;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond()` is true or the budget lapses (events arrive async over pub/sub). */
async function until(cond: () => boolean, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (!cond() && Date.now() < deadline) await delay(20);
}

describe.skipIf(!REDIS_URL)('RedisControlPlane (real Redis)', () => {
  const clients: Redis[] = [];
  const planes: RedisControlPlane[] = [];
  let ns = 0;

  beforeAll(() => {
    // touch one client up-front so a bad URL fails fast
    const r = new Redis(REDIS_URL as string);
    clients.push(r);
  });

  afterEach(async () => {
    for (const p of planes) await p.close();
    planes.length = 0;
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  /** A fresh ioredis client (each test gets its own connections + channel prefix). */
  function client() {
    const c = new Redis(REDIS_URL as string);
    clients.push(c);
    return c;
  }

  /** A control plane on its own connection, sharing the test's channel prefix. */
  function plane(prefix: string) {
    // A real ioredis client goes in unassisted: the port's ioredis arm declares `subscribe(channel)`
    // only, matching ioredis's variadic-channels overload. This used to need a cast — see
    // `test/types/redis-pubsub-assignability.ts`, which fails the build if that regresses.
    const p = new RedisControlPlane({ connection: client(), prefix });
    planes.push(p);
    return p;
  }

  /** Two engines (distinct instanceIds) sharing one in-memory store + one Redis control channel. */
  function twoPods(prefix: string) {
    const store = new InMemoryStateStore();
    const worker = new WorkflowEngine({
      store,
      controlPlane: plane(prefix),
      instanceId: 'worker',
    });
    const dashboard = new WorkflowEngine({
      store,
      controlPlane: plane(prefix),
      instanceId: 'dashboard',
    });
    return { store, worker, dashboard };
  }

  it('delivers a cancel from one pod to the pod running the work', async () => {
    const { worker, dashboard } = twoPods(`cp${++ns}`);
    const aborted: string[] = [];
    worker.onCancel((runId) => aborted.push(runId));
    await delay(100); // let both subscribers connect

    worker.register('wf', '1', async (ctx) => ctx.waitForSignal('go'));
    await startRun(worker, 'wf', {}, 'run1'); // suspends, "work" in flight on the worker

    await dashboard.cancel('run1'); // issued from the OTHER pod
    await until(() => aborted.length > 0);
    expect(aborted).toEqual(['run1']);
  });

  it('fans out lifecycle events to another pod, each exactly once (from dedupe)', async () => {
    const { worker, dashboard } = twoPods(`cp${++ns}`);
    const onWorker: string[] = [];
    const onDashboard: string[] = [];
    worker.subscribe((e) => onWorker.push(e.type));
    dashboard.subscribe((e) => onDashboard.push(e.type));
    await delay(100); // let both subscribers connect

    worker.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      return 'ok';
    });
    await startRun(worker, 'wf', {}, 'run1');

    const expected = ['run.started', 'step.started', 'step.completed', 'run.completed'];
    // The dashboard pod, which executed nothing, still sees every event over Redis.
    await until(() => onDashboard.length >= expected.length);
    expect(onDashboard).toEqual(expected);
    // And the worker delivered each event exactly once — no echo of its own Redis publish back to it.
    expect(onWorker).toEqual(expected);
  });

  it('ignores a malformed payload published on the control channel', async () => {
    const prefix = `cp${++ns}`;
    const received: string[] = [];
    const sub = plane(prefix);
    sub.onControl((m) => received.push(m.kind));
    await delay(100); // let the subscriber connect

    // Raw garbage on the channel must be swallowed (never throw / crash the engine)...
    await client().publish(`${prefix}-control`, 'not-json{');
    await delay(150);
    expect(received).toEqual([]);

    // ...and a well-formed message after it still gets through.
    await plane(prefix).publishControl({ kind: 'cancel', runId: 'r9', from: 'other' });
    await until(() => received.length > 0);
    expect(received).toEqual(['cancel']);
  });
});

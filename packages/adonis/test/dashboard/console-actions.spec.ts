import { describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  completeTaskRun,
  type Deps,
  failTaskRun,
  signalRun,
  updateRun,
} from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * The console's human-in-the-loop verbs: deliver a signal / validated update / task completion
 * through the same bounded {@link Deps} port the JSON routes drive — over a real in-memory engine,
 * mirroring handlers.spec.ts's wiring.
 */
function makeEngine(): { raw: WorkflowEngine; deps: Deps } {
  const store = new InMemoryStateStore();
  const raw = new WorkflowEngine({ store, transport: new InMemoryTransport() });

  raw.register('approval', '1', async (ctx) => {
    const verdict = await ctx.waitForSignal<{ approved: boolean }>('approve:42');
    return verdict.approved ? 'approved' : 'denied';
  });

  raw.register('settings', '1', async (ctx) => {
    const limit = await ctx.onUpdate<number>('set-limit');
    return `limit:${limit}`;
  });
  raw.registerUpdateValidator('settings', 'set-limit', (arg: unknown) =>
    typeof arg === 'number' ? undefined : 'not a number',
  );

  return { raw, deps: { engine: storeDashboardEngine(raw) } };
}

describe('console signal delivery', () => {
  it('delivers a signal the run is waiting on and resumes it', async () => {
    const { raw, deps } = makeEngine();
    await raw.start('approval', {}, 'r1');
    await flush();
    expect((await raw.getRun('r1'))?.status).toBe('suspended');

    const res = await signalRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { token: 'approve:42', payload: { approved: true } },
    });
    expect(res.status).toBe(200);
    await flush();
    const run = await raw.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('approved');
  });

  it('409s (with the waiting tokens) on a token the run is NOT waiting on, unless forced', async () => {
    const { raw, deps } = makeEngine();
    await raw.start('approval', {}, 'r1');
    await flush();

    const res = await signalRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { token: 'aprove:42', payload: {} }, // typo
    });
    expect(res.status).toBe(409);
    expect((res.body as { waitingOn: string[] }).waitingOn).toEqual(['approve:42']);

    const forced = await signalRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { token: 'aprove:42', payload: {}, force: true },
    });
    expect(forced.status).toBe(200); // buffered — explicit operator override
  });

  it('400s without a token and 404s an unknown run', async () => {
    const { deps } = makeEngine();
    expect((await signalRun(deps, { params: { id: 'r1' }, query: {}, body: {} })).status).toBe(400);
    expect(
      (await signalRun(deps, { params: { id: 'nope' }, query: {}, body: { token: 't' } })).status,
    ).toBe(404);
  });
});

describe('console update delivery', () => {
  it('delivers a validator-accepted update', async () => {
    const { raw, deps } = makeEngine();
    await raw.start('settings', {}, 'u1');
    await flush();

    const res = await updateRun(deps, {
      params: { id: 'u1', name: 'set-limit' },
      query: {},
      body: { arg: 99 },
    });
    expect(res.status).toBe(200);
    await flush();
    expect((await raw.getRun('u1'))?.output).toBe('limit:99');
  });

  it('422s a validator-rejected update with the reason, delivering nothing', async () => {
    const { raw, deps } = makeEngine();
    await raw.start('settings', {}, 'u1');
    await flush();

    const res = await updateRun(deps, {
      params: { id: 'u1', name: 'set-limit' },
      query: {},
      body: { arg: 'lots' },
    });
    expect(res.status).toBe(422);
    expect((res.body as { error: string }).error).toBe('not a number');
    expect((await raw.getRun('u1'))?.status).toBe('suspended'); // untouched
  });
});

describe('console task completion', () => {
  it('completes a waiting ctx.task (delivered) and reports buffering when none waits yet', async () => {
    const store = new InMemoryStateStore();
    const raw = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    raw.register('shipping', '1', async (ctx) => {
      const out = await ctx.task<string>('label', async () => {});
      return `label:${out}`;
    });
    const deps: Deps = { engine: storeDashboardEngine(raw) };

    await raw.start('shipping', {}, 't1');
    await flush();
    const res = await completeTaskRun(deps, {
      params: { id: 't1', name: 'label' },
      query: {},
      body: { result: 'LBL-1' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { delivered: boolean }).delivered).toBe(true);
    await flush();
    expect((await raw.getRun('t1'))?.output).toBe('label:LBL-1');

    // No run waiting on this task token yet → buffered, honestly reported.
    const buffered = await failTaskRun(deps, {
      params: { id: 'ghost', name: 'label' },
      query: {},
      body: { error: 'nope' },
    });
    expect(buffered.status).toBe(200);
    expect((buffered.body as { delivered: boolean }).delivered).toBe(false);
  });
});

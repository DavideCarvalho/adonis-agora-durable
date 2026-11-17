import { describe, expect, it } from 'vitest';
import { decodeConsoleValue, encodeConsoleValue } from '../../src/console-commands.js';
import {
  answerConsoleCommands,
  FEDERATED_APP_UNREACHABLE,
  FederatedApp,
} from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  cancelRun,
  getRun,
  listRuns,
  retryRun,
  scheduleAction,
  signalRun,
  workers,
} from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { ConsoleCommand, EngineEvent } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { consoleBus } from '../support/console-bus.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await delay(10);
  }
}

/**
 * The owning app ("b"): its own store and engine, answering console commands on its control plane.
 * The console app ("a") has an engine and store of its own, which nothing here may touch.
 */
function setup() {
  const bus = consoleBus();
  const storeB = new InMemoryStateStore();
  const engineB = new WorkflowEngine({ store: storeB, controlPlane: bus.plane(), instanceId: 'b' });
  let flakyCalls = 0;
  engineB.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
  engineB.register('flaky', '1', async (ctx) =>
    ctx.localStep('try', async () => {
      flakyCalls += 1;
      if (flakyCalls === 1) throw new Error('first attempt fails');
      return 'ok';
    }),
  );
  const ran: ConsoleCommand[] = [];
  const logged: string[] = [];
  const target = storeDashboardEngine(engineB);
  const ownerPlane = bus.plane();
  const wrapped = ownerPlane.onConsoleCommand?.bind(ownerPlane);
  ownerPlane.onConsoleCommand = (h) =>
    wrapped?.((c) => {
      ran.push(c);
      return h(c);
    });
  answerConsoleCommands(ownerPlane, target, (line) => logged.push(line));

  const storeA = new InMemoryStateStore();
  const engineA = new WorkflowEngine({ store: storeA, instanceId: 'a' });
  const app = new FederatedApp({
    id: 'b',
    label: 'App B',
    store: storeB,
    controlPlane: bus.plane(),
  });
  return { bus, storeA, storeB, engineA, engineB, app, ran, logged };
}

describe('federated console', () => {
  it('lists and reads the other app’s runs from its store', async () => {
    const { engineB, app } = setup();
    await startRun(engineB, 'approval', { n: 1 }, 'b-run-1');
    const deps = { engine: app.engine('ops@example.test') };

    const list = await listRuns(deps, { params: {}, query: {} });
    expect(list.status).toBe(200);
    const rows = (list.body as { data: Array<{ id: string; status: string }> }).data;
    expect(rows.map((r) => r.id)).toEqual(['b-run-1']);
    expect(rows[0]?.status).toBe('suspended');

    const detail = await getRun(deps, { params: { id: 'b-run-1' }, query: {} });
    expect(detail.status).toBe(200);
    expect((detail.body as { run: { workflow: string } }).run.workflow).toBe('approval');
  });

  it('pages the other app’s runs by cursor, the same walk as this app’s', async () => {
    const { engineB, app } = setup();
    for (let i = 1; i <= 5; i += 1) await startRun(engineB, 'approval', {}, `b-page-${i}`);
    const deps = { engine: app.engine() };
    type Page = {
      data: Array<{ id: string }>;
      meta: { nextCursor: string | null; hasNext: boolean };
    };
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const res = await listRuns(deps, {
        params: {},
        query: { first: '2', ...(after ? { after } : {}) },
      });
      expect(res.status).toBe(200);
      const body = res.body as Page;
      expect(body.meta).not.toHaveProperty('total');
      seen.push(...body.data.map((r) => r.id));
      if (!body.meta.hasNext) break;
      after = body.meta.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set([1, 2, 3, 4, 5].map((i) => `b-page-${i}`)));
  });

  it('sends a signal to the owning engine, which resumes its run', async () => {
    const { engineB, app, ran, logged, storeA } = setup();
    await startRun(engineB, 'approval', {}, 'b-run-2');
    const deps = { engine: app.engine('ops@example.test') };

    const res = await signalRun(deps, {
      params: { id: 'b-run-2' },
      query: {},
      body: { token: 'approve', payload: { ok: true } },
    });
    expect(res.status).toBe(200);
    await until(async () => (await engineB.getRun('b-run-2'))?.status === 'completed');
    expect((await engineB.getRun('b-run-2'))?.output).toEqual({ ok: true });
    expect(ran.map((c) => [c.verb, c.actor])).toEqual([['signal', 'ops@example.test']]);
    expect(logged).toEqual(['[durable] federated console: signal approve by ops@example.test']);
    // The console app's own store never saw any of it.
    expect(await storeA.listRuns({})).toEqual([]);
  });

  it('cancels and retries through the owning engine', async () => {
    const { engineB, app, ran } = setup();
    await startRun(engineB, 'approval', {}, 'b-run-3');
    const deps = { engine: app.engine() };

    const cancelled = await cancelRun(deps, { params: { id: 'b-run-3' }, query: {} });
    expect(cancelled.status).toBe(200);
    expect((await engineB.getRun('b-run-3'))?.status).toBe('cancelled');

    await startRun(engineB, 'flaky', {}, 'b-run-4').catch(() => undefined);
    await until(async () => (await engineB.getRun('b-run-4'))?.status === 'failed');
    const retried = await retryRun(deps, { params: { id: 'b-run-4' }, query: {} });
    expect(retried.status).toBe(200);
    await until(async () => (await engineB.getRun('b-run-4'))?.status === 'completed');
    expect(ran.map((c) => c.verb)).toEqual(['cancel', 'requeue']);
  });

  it('answers 404 for an unknown run without bothering the owning app', async () => {
    const { app, ran } = setup();
    const deps = { engine: app.engine() };
    const res = await getRun(deps, { params: { id: 'nope' }, query: {} });
    expect(res.status).toBe(404);
    expect(ran).toEqual([]);
  });

  it('reads schedules and worker health from the owning engine', async () => {
    const { app, ran } = setup();
    const deps = { engine: app.engine() };
    expect((await workers(deps)).status).toBe(200);
    const paused = await scheduleAction(deps, {
      params: { key: 'missing', action: 'pause' },
      query: {},
    });
    expect(paused.status).toBe(404);
    expect(ran.map((c) => c.verb)).toEqual(['workerHealth', 'setSchedulePaused']);
  });

  it('fails an action with a clear error when the owning app does not listen', async () => {
    const bus = consoleBus();
    const store = new InMemoryStateStore();
    const app = new FederatedApp({ id: 'down', store, controlPlane: bus.plane() });
    await expect(app.engine().cancel('x')).rejects.toMatchObject({
      code: FEDERATED_APP_UNREACHABLE,
    });
  });

  it('refuses a verb outside the allowlist', async () => {
    const bus = consoleBus();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    answerConsoleCommands(bus.plane(), storeDashboardEngine(engine));
    const reply = await bus.plane().sendConsoleCommand?.({ id: '1', verb: 'start', args: [] });
    expect(reply).toMatchObject({ ok: false, error: { code: 'unsupported-request' } });
  });

  it('live-tails the other app’s run from its control plane', async () => {
    const { engineB, app } = setup();
    const seen: EngineEvent[] = [];
    const stop = app.engine().subscribe('b-run-5', (e) => seen.push(e));
    await startRun(engineB, 'approval', {}, 'b-run-5');
    await until(() => seen.some((e) => e.type === 'run.suspended'));
    expect(seen.every((e) => e.runId === 'b-run-5')).toBe(true);
    expect(seen[0]?.at).toBeInstanceOf(Date);
    stop();
  });
});

describe('console command codec', () => {
  it('keeps dates and undefined across the JSON trip', () => {
    const value = {
      at: new Date('2026-11-17T10:00:00.000Z'),
      list: [new Date(0)],
      gone: undefined,
    };
    const wire = JSON.parse(JSON.stringify(encodeConsoleValue(value)));
    expect(decodeConsoleValue(wire)).toEqual({
      at: new Date('2026-11-17T10:00:00.000Z'),
      list: [new Date(0)],
    });
    expect(decodeConsoleValue(JSON.parse(JSON.stringify(encodeConsoleValue(undefined))))).toBe(
      undefined,
    );
    expect(decodeConsoleValue(encodeConsoleValue(null))).toBe(null);
  });
});

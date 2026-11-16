import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { runTraceId } from '../../src/run-trace.js';
import {
  DurableTelescopeWatcher,
  durableEntryTags,
  durableRecentFailuresProvider,
  durableStateBreakdownProvider,
  durableStateProvider,
  durableTimeseriesProvider,
  durableWorkerHealthProvider,
  registerControlPlaneWatcher,
  telescopeRuntimeRecorder,
} from '../../src/telescope/index.js';
import type {
  ExtensionContext,
  TelescopeEntryLike,
  TelescopeRecordInput,
} from '../../src/telescope/telescope-sdk.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');
const RUNTIME_SLOT = Symbol.for('@agora/telescope:runtime');
const AUTO_SLOT = Symbol.for('@agora/durable:telescope-auto-watcher');
const slot = globalThis as Record<symbol, unknown>;

/** Publish envelopes like `@adonis-agora/diagnostics`, honouring an explicit `traceId`. */
function installDiagnostics(): void {
  slot[EMIT_SLOT] = (
    lib: string,
    event: string,
    payload: unknown,
    options?: { traceId?: string },
  ) => {
    const ch = channel(`agora:${lib}:${event}`);
    if (!ch.hasSubscribers) return;
    ch.publish({ v: 1, ts: Date.now(), lib, event, traceId: options?.traceId, payload });
  };
}

/** A Telescope runtime slot over an in-memory list. */
function installTelescope(): { recorded: TelescopeRecordInput[]; runtime: { paused: boolean } } {
  const recorded: TelescopeRecordInput[] = [];
  const runtime = {
    paused: false,
    store: { record: (e: TelescopeRecordInput) => recorded.push(e) },
  };
  slot[RUNTIME_SLOT] = runtime;
  return { recorded, runtime };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  delete slot[EMIT_SLOT];
  delete slot[CLAIMS_SLOT];
  delete slot[RUNTIME_SLOT];
  delete slot[AUTO_SLOT];
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('control plane → Telescope, attributed per tenant app', () => {
  it('tags a tenant event `app:<partition>` and keeps the durable tags', () => {
    const tags = durableEntryTags({ type: 'run.failed', runId: 'r1', workflow: 'w', app: 'acme' });
    expect(tags).toEqual(expect.arrayContaining(['durable', 'run.failed', 'app:acme', 'run:r1']));
    expect(
      durableEntryTags({ type: 'run.failed', runId: 'r1' }).some((t) => t.startsWith('app:')),
    ).toBe(false);
  });

  it('records every tenant event once, with `lib:durable` + `app:<partition>` + its run trace', async () => {
    installDiagnostics();
    const { recorded } = installTelescope();
    cleanups.push(registerControlPlaneWatcher());
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    cleanups.push(
      attachDurableDiagnostics(engine, {
        tenants: { namespaceOf: async (id) => (await engine.getRun(id))?.namespace },
      }),
    );
    engine.register('w', '1', async (ctx) => ctx.localStep('s', async () => 'ok'));
    await engine.start('w', {}, 'r-acme', { namespace: 'acme' });
    await engine.waitForRun('r-acme');
    await engine.start('w', {}, 'r-own');
    await engine.waitForRun('r-own');
    await flush();

    const acme = recorded.filter((e) => e.tags?.includes('run:r-acme'));
    expect(acme.map((e) => (e.content as { event: string }).event)).toEqual([
      'run.started',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
    for (const e of acme) {
      expect(e.tags).toEqual(expect.arrayContaining(['lib:durable', 'app:acme']));
      expect(e.traceId).toBe(runTraceId('r-acme'));
    }
    const own = recorded.filter((e) => e.tags?.includes('run:r-own'));
    expect(own.length).toBeGreaterThan(0);
    expect(own.some((e) => e.tags?.some((t) => t.startsWith('app:')))).toBe(false);
  });

  it('records nothing while Telescope is paused or has no store', () => {
    const { recorded, runtime } = installTelescope();
    const recorder = telescopeRuntimeRecorder();
    runtime.paused = true;
    recorder.record({ type: 'diagnostic', content: {} });
    expect(recorded).toEqual([]);
    delete slot[RUNTIME_SLOT];
    expect(() => recorder.record({ type: 'diagnostic', content: {} })).not.toThrow();
  });

  it('does not register a second watcher when the host already wired one, and yields to one wired later', () => {
    installTelescope();
    const manual: TelescopeRecordInput[] = [];
    const host = new DurableTelescopeWatcher();
    host.register({ record: (e) => manual.push(e) });
    cleanups.push(() => host.dispose());
    registerControlPlaneWatcher();
    expect((slot[AUTO_SLOT] as { watcher?: unknown }).watcher).toBeUndefined();
    host.dispose();

    cleanups.push(registerControlPlaneWatcher());
    expect((slot[AUTO_SLOT] as { watcher?: unknown }).watcher).toBeDefined();
    const later = new DurableTelescopeWatcher();
    later.register({ record: () => undefined });
    cleanups.push(() => later.dispose());
    expect((slot[AUTO_SLOT] as { watcher?: unknown }).watcher).toBeUndefined();
  });
});

describe('providers filtered by `query.app`', () => {
  function makeCtx(engine: WorkflowEngine, entries: TelescopeEntryLike[] = []): ExtensionContext {
    return {
      store: { list: async () => entries },
      container: { make: async () => engine as never },
      config: {},
    };
  }

  const entry = (event: string, payload: Record<string, unknown>): TelescopeEntryLike => ({
    content: { lib: 'durable', event, payload },
    createdAt: new Date(),
  });

  async function tenantsEngine(): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.register('ok', '1', async () => 'done');
    engine.register('boom', '1', async (ctx) =>
      ctx.localStep('x', async () => {
        throw new Error('kaboom');
      }),
    );
    for (const [id, wf, ns] of [
      ['a-ok', 'ok', 'acme'],
      ['a-bad', 'boom', 'acme'],
      ['g-ok', 'ok', 'globex'],
      ['g-ok2', 'ok', 'globex'],
    ] as const) {
      await engine.start(wf, {}, id, { namespace: ns });
      await engine.waitForRun(id);
    }
    return engine;
  }

  it('engine-backed: state, stateBreakdown and recentFailures read only that app’s runs', async () => {
    const engine = await tenantsEngine();
    const ctx = makeCtx(engine);
    expect(
      await durableStateProvider().resolve({ status: 'completed', app: 'globex' }, ctx),
    ).toEqual({ value: 2 });
    expect(await durableStateProvider().resolve({ status: 'completed' }, ctx)).toEqual({
      value: 3,
    });
    const breakdown = (await durableStateBreakdownProvider().resolve({ app: 'acme' }, ctx)) as {
      segments: Array<{ label: string; value: number }>;
    };
    expect(breakdown.segments.find((s) => s.label === 'completed')?.value).toBe(1);
    const failures = (await durableRecentFailuresProvider().resolve({ app: 'globex' }, ctx)) as {
      rows: unknown[];
    };
    expect(failures.rows).toEqual([]);
    const acmeFailures = (await durableRecentFailuresProvider().resolve({ app: 'acme' }, ctx)) as {
      rows: Array<{ runId: string }>;
    };
    expect(acmeFailures.rows.map((r) => r.runId)).toEqual(['a-bad']);
  });

  it('engine-backed: workerHealth keeps the `<name>@<app>` groups', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    (engine as unknown as { workerHealth: () => Promise<unknown[]> }).workerHealth = async () => [
      { group: 'charge@acme', depth: 1, liveWorkers: [] },
      { group: 'charge@globex', depth: 0, liveWorkers: [{}] },
    ];
    const res = (await durableWorkerHealthProvider().resolve({ app: 'acme' }, makeCtx(engine))) as {
      rows: Array<{ group: string }>;
    };
    expect(res.rows.map((r) => r.group)).toEqual(['charge@acme']);
  });

  it('entry-backed: timeseries counts only the events attributed to that app', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const ctx = makeCtx(engine, [
      entry('run.completed', { runId: '1', workflow: 'w', app: 'acme' }),
      entry('run.failed', { runId: '2', workflow: 'w', app: 'acme' }),
      entry('run.failed', { runId: '3', workflow: 'v', app: 'globex' }),
      entry('run.completed', { runId: '4', workflow: 'own' }),
    ]);
    const provider = durableTimeseriesProvider();
    expect(await provider.resolve({ metric: 'total', app: 'acme' }, ctx)).toEqual({ value: 2 });
    expect(await provider.resolve({ metric: 'failed', app: 'globex' }, ctx)).toEqual({ value: 1 });
    expect(await provider.resolve({ metric: 'total' }, ctx)).toEqual({ value: 4 });
    expect(await provider.resolve({ metric: 'topFailures', app: 'globex' }, ctx)).toEqual({
      items: [{ label: 'v', value: 1 }],
    });
  });
});

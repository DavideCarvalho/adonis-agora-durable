import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/dashboard/define_config.js';
import type { DashboardEngine } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { consoleBus } from '../support/console-bus.js';

/** The provider's `?app=` selection, reached through its TS-private methods on purpose. */
interface ProviderInternals {
  selectedApp(config: unknown, ctx: unknown): Promise<string | null | undefined>;
  visibleApps(
    config: unknown,
    ctx: unknown,
  ): Promise<Array<{ id: string; label: string; mode?: string; actions?: string }>>;
  consoleDeps(
    config: unknown,
    topology: string,
  ): (ctx?: unknown) => Promise<{
    engine: DashboardEngine;
    metrics?: unknown;
  }>;
}

function ctxWith(qs: Record<string, string>) {
  return {
    request: {
      qs: () => qs,
      url: () => '/durable/api/runs',
      method: () => 'GET',
      header: () => undefined,
    },
    auth: { user: { email: 'ops@example.test' } },
  } as never;
}

async function provider(): Promise<ProviderInternals> {
  const { default: DashboardProvider } = await import('../../providers/dashboard_provider.js');
  const app = { config: { get: (_key: string, fallback?: unknown) => fallback ?? {} } };
  return new DashboardProvider(app as never) as unknown as ProviderInternals;
}

describe('federated console — config', () => {
  it('rejects an app key that cannot travel in the URL', () => {
    const bus = consoleBus();
    const store = new InMemoryStateStore();
    expect(() =>
      resolveConfig({ apps: { 'bad key!': { store, controlPlane: bus.plane() } } }),
    ).toThrow(/not a valid app key/);
  });

  it('defaults to no other app and labels this one', () => {
    const config = resolveConfig({});
    expect(config.apps).toEqual({});
    expect(config.appLabel).toBe('This app');
  });
});

describe('federated console — app selection in the provider', () => {
  const bus = consoleBus();
  const store = new InMemoryStateStore();
  const apps = {
    'entre-textos': { label: 'Entre Textos', store, controlPlane: bus.plane() },
    eduliberta: { store: new InMemoryStateStore(), controlPlane: bus.plane() },
  };

  it('reads ?app= against the configured apps and the authorize grant', async () => {
    const p = await provider();
    const open = resolveConfig({ authorize: () => true, apps });
    expect(await p.selectedApp(open, ctxWith({}))).toBeUndefined();
    expect(await p.selectedApp(open, ctxWith({ app: 'entre-textos' }))).toBe('entre-textos');
    expect(await p.selectedApp(open, ctxWith({ app: 'nope' }))).toBeNull();
    expect(await p.selectedApp(open, ctxWith({ app: 'toString' }))).toBeNull();
    expect(await p.visibleApps(open, ctxWith({}))).toEqual([
      { id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'app' },
      { id: 'eduliberta', label: 'eduliberta', mode: 'federated', actions: 'app' },
    ]);

    const narrowed = resolveConfig({
      authorize: () => ({ allowed: true, apps: ['eduliberta'] }),
      apps,
    });
    expect(await p.selectedApp(narrowed, ctxWith({ app: 'entre-textos' }))).toBeNull();
    expect(await p.visibleApps(narrowed, ctxWith({}))).toEqual([
      { id: 'eduliberta', label: 'eduliberta', mode: 'federated', actions: 'app' },
    ]);
  });

  it('says who runs actions: the app, unless its control plane cannot carry console commands', async () => {
    const p = await provider();
    const { sendConsoleCommand: _send, ...browseOnly } = bus.plane();
    const config = resolveConfig({
      authorize: () => true,
      apps: {
        // A factory is not built to answer `/apps`: the shipped ones carry console commands.
        factory: { store, controlPlane: async () => bus.plane() },
        browse: { label: 'Browse only', store, controlPlane: browseOnly },
      },
    });
    expect(await p.visibleApps(config, ctxWith({}))).toEqual([
      { id: 'factory', label: 'factory', mode: 'federated', actions: 'app' },
      { id: 'browse', label: 'Browse only', mode: 'federated', actions: 'none' },
    ]);
  });

  it('serves the selected app’s runs, and refuses an unknown one', async () => {
    const owner = new WorkflowEngine({ store, instanceId: 'et' });
    owner.register('job', '1', async () => 'ok');
    await startRun(owner, 'job', {}, 'et-1');

    const p = await provider();
    const config = resolveConfig({ authorize: () => true, apps });
    const deps = p.consoleDeps(config, 'standalone');
    const selected = await deps(ctxWith({ app: 'entre-textos' }));
    expect((await selected.engine.listRuns({})).map((r) => r.id)).toEqual(['et-1']);
    // This process's counters are not the other app's.
    expect(selected.metrics).toBeUndefined();
    await expect(deps(ctxWith({ app: 'nope' }))).rejects.toMatchObject({
      name: 'UnknownConsoleAppError',
    });
  });
});

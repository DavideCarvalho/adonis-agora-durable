import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';

/**
 * Minimal Adonis app double for the embedded worker loop. Deliberately has NO `logger` binding —
 * `container.make('logger')` throws here, exercising the provider's fallback path (a swallowed
 * failure there would leave loop errors invisible in a real app too).
 */
function fakeApp(config: DurableConfig = {}, environment = 'web') {
  let factory: (() => unknown) | undefined;
  let singleton: unknown;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    getEnvironment: () => environment,
    makePath: (...parts: string[]) => ['/app', ...parts].join('/'),
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async (key: unknown) => {
        if (key === WorkflowEngine) {
          if (!singleton) singleton = await factory?.();
          return singleton as WorkflowEngine;
        }
        const Ctor = key as new () => unknown;
        return new Ctor();
      },
    },
  } as unknown as ApplicationService;
  return { app, resolve: async () => (await app.container.make(WorkflowEngine)) as WorkflowEngine };
}

/** Poll until `predicate` holds, or give up after `timeoutMs` (returns whether it held). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

/**
 * Wire a provider whose config carries one schedule due immediately (the current `everyMs` window has
 * no run yet, so the first tick that reaches the schedules phase starts it). `runs` records each
 * execution, so "did the loop tick?" is observable rather than inferred from timing.
 */
async function scheduledApp(worker: DurableConfig['worker'], environment = 'web') {
  const runs: string[] = [];
  const { app, resolve } = fakeApp(
    {
      ...(worker ? { worker } : {}),
      schedules: [{ key: 'sync', workflow: 'sync', everyMs: 60_000 }],
    },
    environment,
  );
  const provider = new DurableProvider(app);
  provider.register();
  const engine = await resolve();
  engine.register('sync', '1', async () => {
    runs.push('tick');
    return null;
  });
  return { provider, engine, runs };
}

describe('DurableProvider — embedded worker', () => {
  it('does not start a loop by default (schedules stay dormant without durable:work)', async () => {
    const { provider, runs } = await scheduledApp(undefined);

    await provider.ready();
    // Long enough that an embedded loop at any sane interval would have ticked.
    await waitFor(() => runs.length > 0, 150);

    expect(runs).toEqual([]);
    await provider.shutdown();
  });

  it('fires a due schedule in-process when worker.embedded is on', async () => {
    const { provider, runs } = await scheduledApp({ embedded: true, intervalMs: 5 });

    await provider.ready();
    const fired = await waitFor(() => runs.length > 0);

    expect(fired).toBe(true);
    await provider.shutdown();
  });

  it('starts no loop outside the web environment', async () => {
    // The guard that keeps `node ace durable:work` from running TWO loops in one process — the
    // command's and an embedded one — and keeps `node ace migration:run` from becoming a worker.
    const { provider, runs } = await scheduledApp({ embedded: true, intervalMs: 5 }, 'console');

    await provider.ready();
    await waitFor(() => runs.length > 0, 150);

    expect(runs).toEqual([]);
    await provider.shutdown();
  });

  it('shutdown stops the loop and awaits it, so no tick lands after shutdown returns', async () => {
    const { provider, runs } = await scheduledApp({ embedded: true, intervalMs: 5 });
    await provider.ready();
    expect(await waitFor(() => runs.length > 0)).toBe(true);

    await provider.shutdown();
    const afterShutdown = runs.length;
    // If shutdown returned while the loop was still live, a later tick would keep appending.
    await new Promise((r) => setTimeout(r, 100));

    expect(runs.length).toBe(afterShutdown);
  });

  it('shutdown is safe when no embedded loop was started', async () => {
    const { provider } = await scheduledApp(undefined);
    await provider.ready();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { InMemoryTransport, WorkflowEngine } from '../src/index.js';

/**
 * `node ace codegen` boots the app in `warmup` mode (`boot()` + `warmUp()`, then `terminate()`), which
 * skips every provider's `shutdown()`. A provider that builds its transport there opens connections
 * (the `@adonisjs/queue` Redis adapter, a Lucid store…) that nothing ever closes, so the command never
 * exits. `@adonisjs/queue` 0.7 stopped resolving its manager in warmup; durable must not resolve it
 * either — through the engine's transport factory — and must stay lazily resolvable.
 */
function fakeApp(mode: 'run' | 'warmup' | undefined) {
  let transportBuilds = 0;
  const config: DurableConfig = {
    transport: 'spy',
    transports: {
      spy: async () => {
        transportBuilds += 1;
        return new InMemoryTransport();
      },
    },
    workflowsPath: 'app/workflows',
    stepsPath: false,
  };
  const factories = new Map<unknown, () => unknown>();
  const instances = new Map<unknown, unknown>();
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    getEnvironment: () => 'console',
    ...(mode ? { getMode: () => mode } : {}),
    makePath: (...parts: string[]) => join('/nonexistent-durable-app', ...parts),
    container: {
      singleton: (key: unknown, f: () => unknown) => {
        factories.set(key, f);
      },
      make: async (key: unknown) => {
        if (!instances.has(key)) instances.set(key, await factories.get(key)?.());
        return instances.get(key);
      },
    },
  } as unknown as ApplicationService;
  return { app, transportBuilds: () => transportBuilds };
}

describe('DurableProvider in warmup mode', () => {
  it('boot() and ready() build no transport (no connection opened) when warming up', async () => {
    const { app, transportBuilds } = fakeApp('warmup');
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();
    await provider.ready();
    expect(transportBuilds()).toBe(0);

    // Still resolvable on demand — e.g. a codegen hook that really asks for the engine.
    const engine = await app.container.make(WorkflowEngine);
    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(transportBuilds()).toBe(1);
    await provider.shutdown();
  });

  it('boot() still builds the transport in run mode', async () => {
    const { app, transportBuilds } = fakeApp('run');
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();
    expect(transportBuilds()).toBe(1);
    await provider.shutdown();
  });

  it('an app without getMode (older @adonisjs/core) behaves as run mode', async () => {
    const { app, transportBuilds } = fakeApp(undefined);
    const provider = new DurableProvider(app);
    provider.register();
    await provider.boot();
    expect(transportBuilds()).toBe(1);
    await provider.shutdown();
  });
});

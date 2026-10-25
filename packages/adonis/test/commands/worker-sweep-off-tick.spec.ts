import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../../providers/durable_provider.js';
import { runTick, runWorkerLoop, type WorkerLogger } from '../../src/commands/worker.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

/**
 * The buffered-signal sweep is housekeeping. A slow one (a big backlog on a slow database) must not
 * hold up the phases of the tick that started it, the next tick's `runPending`, or the boot of a
 * process running the embedded worker.
 */

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  return { store, engine };
}

function captureLogger(): WorkerLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m) => errors.push(m) };
}

/** Make `engine.sweepBufferedSignals` hang until the returned `release` is called. */
function hangSweep(engine: WorkflowEngine) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (engine as unknown as { sweepBufferedSignals: () => Promise<number> }).sweepBufferedSignals =
    async () => {
      calls += 1;
      await gate;
      return 0;
    };
  return { release, calls: () => calls };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed out'> {
  return Promise.race([
    promise,
    new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms)),
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

describe('the buffered-signal sweep is off the critical path of a worker tick', () => {
  it('a hanging sweep does not hold up the phases after it', async () => {
    const { engine } = makeEngine();
    const sweep = hangSweep(engine);
    const later: string[] = [];
    for (const name of ['sweepRetention', 'sweepStalled', 'sweepEntityWakes']) {
      (engine as unknown as Record<string, unknown>)[name] = async () => {
        later.push(name);
        return name === 'sweepStalled' ? [] : 0;
      };
    }

    const result = await within(runTick(engine), 500);

    expect(result).not.toBe('timed out');
    expect(sweep.calls()).toBe(1);
    expect(later).toEqual(['sweepRetention', 'sweepStalled', 'sweepEntityWakes']);
    sweep.release();
  });

  it('a hanging sweep does not hold up the next tick, and is not started twice', async () => {
    const { engine } = makeEngine();
    const sweep = hangSweep(engine);
    let pending = 0;
    const runPending = engine.runPending.bind(engine);
    (engine as unknown as { runPending: typeof runPending }).runPending = async (now) => {
      pending += 1;
      return runPending(now);
    };
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let sleeps = 0;
    const sleep = async (): Promise<void> => {
      sleeps += 1;
      if (sleeps >= 5) stop();
    };

    const ticks = await within(
      runWorkerLoop(engine, {
        intervalMs: 1,
        stopSignal,
        logger: captureLogger(),
        drainTimeoutMs: 100,
        sleep,
      }),
      2_000,
    );

    expect(ticks).not.toBe('timed out');
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(pending).toBeGreaterThanOrEqual(5);
    // Still running from the first tick: no second sweep was stacked on it.
    expect(sweep.calls()).toBe(1);
    sweep.release();
  });

  it('shutdown waits for a sweep in flight, bounded by the drain budget', async () => {
    const { engine } = makeEngine();
    const sweep = hangSweep(engine);
    const logger = captureLogger();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const sleep = async (): Promise<void> => {
      stop();
    };

    const started = Date.now();
    const ticks = await within(
      runWorkerLoop(engine, { intervalMs: 1, stopSignal, logger, drainTimeoutMs: 150, sleep }),
      2_000,
    );

    expect(ticks).not.toBe('timed out');
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(logger.errors.some((m) => m.includes('buffered-signal sweep'))).toBe(true);
    sweep.release();
  });

  it('a sweep that fails in the background is reported by the next tick', async () => {
    const { engine } = makeEngine();
    (engine as unknown as { sweepBufferedSignals: () => Promise<number> }).sweepBufferedSignals =
      async () => {
        throw new Error('sweep boom');
      };

    await runTick(engine);
    await new Promise((r) => setTimeout(r, 0));
    const next = await runTick(engine);

    expect(next.errors.map((e) => [e.phase, e.error.message])).toContainEqual([
      'sweepBufferedSignals',
      'sweep boom',
    ]);
  });
});

describe('DurableProvider boot with the embedded worker and a hanging sweep', () => {
  it('boots, and the loop keeps firing schedules', async () => {
    let factory: (() => unknown) | undefined;
    let singleton: unknown;
    const app = {
      config: {
        get: (key: string, fallback?: unknown) =>
          key === 'durable'
            ? {
                worker: { embedded: true, intervalMs: 5, drainTimeoutMs: 100 },
                schedules: [{ key: 'sync', workflow: 'sync', everyMs: 60_000 }],
              }
            : fallback,
      },
      getEnvironment: () => 'web',
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
    const provider = new DurableProvider(app);
    provider.register();
    const engine = (await app.container.make(WorkflowEngine)) as WorkflowEngine;
    const sweep = hangSweep(engine);
    const runs: string[] = [];
    engine.register('sync', '1', async () => {
      runs.push('tick');
      return null;
    });

    expect(await within(provider.ready(), 500)).not.toBe('timed out');
    expect(await waitFor(() => runs.length > 0)).toBe(true);

    expect(await within(provider.shutdown(), 2_000)).not.toBe('timed out');
    sweep.release();
  });
});

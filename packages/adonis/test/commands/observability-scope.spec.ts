import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTick } from '../../src/commands/worker.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';
import { asHeartbeat, withScheduleOrigin } from '../../src/observability-scope.js';

const ORIGIN_SCOPE = Symbol.for('@agora/telescope:origin-scope');

interface Scope {
  origin?: string;
  heartbeat?: boolean;
}

/**
 * Stand-in for the driver `@adonis-agora/telescope` publishes on the global slot —
 * the same `AsyncLocalStorage` semantics, including merging over an enclosing scope.
 * Installing it here proves the STRUCTURAL contract works end to end without durable
 * importing telescope (it cannot: separate repos, no dependency between them).
 */
function installDriver(): { current: () => Scope | undefined; uninstall: () => void } {
  const storage = new AsyncLocalStorage<Scope>();
  const previous = (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE];
  (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE] = {
    run<T>(scope: Scope, fn: () => T): T {
      return storage.run({ ...storage.getStore(), ...scope }, fn);
    },
    current: () => storage.getStore(),
  };
  return {
    current: () => storage.getStore(),
    uninstall: () => {
      (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE] = previous;
    },
  };
}

/** A store that remembers the ambient scope active during each call it receives. */
function spyStore(current: () => Scope | undefined) {
  const seen: { method: string; scope: Scope | undefined }[] = [];
  const store = new InMemoryStateStore();
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        seen.push({ method: String(prop), scope: current() });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy as InMemoryStateStore, seen };
}

let driver: ReturnType<typeof installDriver>;

beforeEach(() => {
  driver = installDriver();
});
afterEach(() => {
  driver.uninstall();
});

describe('the tick labels itself as scheduler-driven', () => {
  it('runs every phase under origin schedule', async () => {
    const { store, seen } = spyStore(driver.current);
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    await runTick(engine);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.scope?.origin).toBe('schedule');
    }
  });

  it('leaves no scope behind once the tick returns', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    await runTick(engine);
    expect(driver.current()).toBeUndefined();
  });
});

describe('probe reads are marked as heartbeat, and only those', () => {
  it('marks the four "is there work?" reads', async () => {
    const { store, seen } = spyStore(driver.current);
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    await runTick(engine);

    const probes = ['listPendingRuns', 'listIncompleteRuns', 'listDueTimers', 'listRuns'];
    for (const probe of probes) {
      const calls = seen.filter((c) => c.method === probe);
      expect(calls.length, `${probe} was never called`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.scope?.heartbeat, `${probe} must be a heartbeat`).toBe(true);
      }
    }
  });

  it('does NOT mark the work a tick picks up — that history is the point of the console', async () => {
    const { store, seen } = spyStore(driver.current);
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });

    engine.register('greet', '1', async () => 'ok');
    // Park a run as `pending` directly in the store, so the TICK is what finds and runs
    // it — going through `engine.start` would let the in-process dispatcher execute it
    // before the tick ever looked, and the tick is the thing under test.
    await store.createRun({
      id: 'run-1',
      workflow: 'greet',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seen.length = 0;

    await runTick(engine);

    // The probe that FOUND it is a heartbeat…
    const probe = seen.filter((c) => c.method === 'listPendingRuns');
    expect(probe.length).toBeGreaterThan(0);
    expect(probe.every((c) => c.scope?.heartbeat === true)).toBe(true);

    // …and the run's own history — leasing it, saving its outcome — is not.
    const writes = seen.filter((c) => c.method === 'tryLockRun' || c.method === 'updateRun');
    expect(writes.length, 'the tick did no work to observe').toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.scope?.heartbeat, `${write.method} must not be a heartbeat`).not.toBe(true);
      expect(write.scope?.origin).toBe('schedule');
    }
  });
});

describe('with no observability tool installed', () => {
  it('runs the body exactly once and returns its value', () => {
    driver.uninstall();
    (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE] = undefined;
    let calls = 0;
    const value = withScheduleOrigin(() => {
      calls += 1;
      return 'result';
    });
    expect(calls).toBe(1);
    expect(value).toBe('result');
  });

  it('does not re-run a body that legitimately returns undefined', () => {
    driver.uninstall();
    (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE] = undefined;
    let calls = 0;
    const value = asHeartbeat((): undefined => {
      calls += 1;
      return undefined;
    });
    expect(calls).toBe(1);
    expect(value).toBeUndefined();
  });

  it('ignores a slot holding something that is not a driver', () => {
    (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE] = { run: 'not a function' };
    let calls = 0;
    asHeartbeat(() => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

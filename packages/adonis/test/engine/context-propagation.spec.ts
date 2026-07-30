import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask } from '../../src/interfaces.js';
import { runStepHandler } from '../../src/protocol.js';

const CONTEXT_SCOPE = Symbol.for('@agora/context:scope');

function task(context?: Record<string, unknown>): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'payments.charge',
    stepId: 'r1:0',
    group: 'payments',
    input: { amount: 10 },
    attempt: 1,
    ...(context ? { context } : {}),
  };
}

/**
 * A faithful stand-in for `@adonis-agora/context`'s scope slot: it activates a fresh store seeded
 * from `snapshot`, runs `fn` inside it, and tears it down on the way out — so each call is isolated
 * (no cross-task bleed) exactly like the real ALS-backed `Context.run`.
 */
function installFakeScope(): { active: () => Record<string, unknown> | undefined } {
  let store: Record<string, unknown> | undefined;
  (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE] = <T>(
    snapshot: Record<string, unknown> | undefined,
    fn: () => T,
  ): T => {
    const previous = store;
    store = snapshot;
    try {
      return fn();
    } finally {
      store = previous;
    }
  };
  return { active: () => store };
}

describe('cross-process context propagation (worker restore)', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE];
  });

  it('runs the handler INSIDE the restored context scope (handler observes the snapshot)', async () => {
    const scope = installFakeScope();

    let ctxSeenByHandler: Record<string, unknown> | undefined;
    const snapshot = { userRef: 'user-42', tenantId: 'acme', traceId: 'trace-abc' };
    const result = await runStepHandler(task(snapshot), () => {
      // The handler body runs WITHIN the scope, so the active store is the restored snapshot.
      ctxSeenByHandler = scope.active();
      return 'ok';
    });

    expect(result.status).toBe('completed');
    expect(ctxSeenByHandler).toEqual(snapshot);
    // The scope is torn down once the handler returns — no ambient leak afterwards.
    expect(scope.active()).toBeUndefined();
  });

  it('does NOT bleed context between two sequential tasks on a long-lived worker', async () => {
    const scope = installFakeScope();

    const firstSeen: Array<Record<string, unknown> | undefined> = [];
    await runStepHandler(task({ userRef: 'first' }), () => {
      firstSeen.push(scope.active());
      return 'a';
    });

    const secondSeen: Array<Record<string, unknown> | undefined> = [];
    // No context on the second task: its scope must NOT carry the first task's snapshot.
    await runStepHandler(task(), () => {
      secondSeen.push(scope.active());
      return 'b';
    });

    expect(firstSeen).toEqual([{ userRef: 'first' }]);
    expect(secondSeen).toEqual([undefined]);
  });

  it('runs the handler directly (clean no-op) when the scope slot is not installed', async () => {
    const result = await runStepHandler(task({ userRef: 'u' }), () => 'ok');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ok');
  });

  it('surfaces a handler error as the step failure even inside the scope', async () => {
    installFakeScope();
    const result = await runStepHandler(task({ userRef: 'u' }), () => {
      throw new Error('boom');
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('boom');
  });
});

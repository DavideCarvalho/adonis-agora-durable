import { describe, expect, it } from 'vitest';
import { Pollers } from '../../src/pollers.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `cond` (counted, not timed: a loaded machine stretches every interval). */
async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await delay(1);
  }
}

describe('Pollers', () => {
  it('drains greedily while a tick reports work, then sleeps', async () => {
    let calls = 0;
    // A long interval: after the burst drains, the next tick is far enough away that it won't
    // fire during the test, so `calls` reflects exactly the first (greedy) round.
    const pollers = new Pollers(10_000);
    pollers.start(async () => {
      calls += 1;
      return calls < 3; // true, true, false → 3 ticks total
    });
    await until(() => calls >= 3);
    await delay(20);
    expect(calls).toBe(3);
    pollers.stopAll();
  });

  it('keeps polling on its interval while a tick reports no work', async () => {
    let calls = 0;
    const pollers = new Pollers(5);
    pollers.start(async () => {
      calls += 1;
      return false;
    });
    // A loop that stopped after an empty round would never get here.
    await until(() => calls > 2);
    pollers.stopAll();
    expect(calls).toBeGreaterThan(2);
  });

  it('stops every loop on stopAll and runs no further ticks', async () => {
    let calls = 0;
    const pollers = new Pollers(5);
    pollers.start(async () => {
      calls += 1;
      return false;
    });
    await until(() => calls > 1);
    pollers.stopAll();
    const snapshot = calls;
    await delay(30);
    expect(calls).toBe(snapshot);
  });

  it('reports a throwing tick to onError and keeps the loop alive', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const pollers = new Pollers(5, (err) => errors.push(err));
    pollers.start(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return false;
    });
    await until(() => calls > 1);
    pollers.stopAll();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
    expect(calls).toBeGreaterThan(1);
  });

  it('reopen clears the closed flag so later loops may run', async () => {
    const pollers = new Pollers(5);
    pollers.stopAll();
    expect(pollers.closed).toBe(true);
    pollers.reopen();
    expect(pollers.closed).toBe(false);
    let calls = 0;
    pollers.start(async () => {
      calls += 1;
      return false;
    });
    await until(() => calls > 0);
    pollers.stopAll();
    expect(calls).toBeGreaterThan(0);
  });
});

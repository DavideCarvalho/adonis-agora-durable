import { describe, expect, it } from 'vitest';
import { childCompletionNeedsBuffer } from '../../src/buffered-child-signals.js';
import { instantCheckpoint } from '../../src/checkpoints.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, StepCheckpoint, WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * What the buffered-signal sweep and the child-completion check cost in store calls. A read by
 * checkpoint name scans the parent's checkpoints (or, with the `(run_id, name)` index, still costs
 * one statement per buffered row), so a wide fan's parent with thousands of buffered completions
 * turns a sweep tick into thousands of statements. Reads by `(run_id, seq)` hit the primary key and
 * are batched per parent.
 */
const NAME_READS = [
  'listCheckpoints',
  'listCheckpointsByNamePrefix',
  'getLatestCheckpointByName',
  'queryCheckpoints',
];

const PAGE = 500;

function counting(inner: InMemoryStateStore, delayMs = 0) {
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        calls.push(prop);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as StateStore;
  return {
    store,
    calls,
    reset: () => {
      calls.length = 0;
    },
    nameReads: () => calls.filter((c) => NAME_READS.includes(c)),
    pages: () => calls.filter((c) => c === 'listBufferedSignals').length,
  };
}

function parentRun(id: string, status: WorkflowRun['status'] = 'running'): WorkflowRun {
  const at = new Date();
  return {
    id,
    workflow: 'load',
    workflowVersion: '1',
    status,
    input: {},
    createdAt: at,
    updatedAt: at,
  };
}

const cp = (runId: string, seq: number, name: string, output: unknown): StepCheckpoint =>
  instantCheckpoint({ runId, seq, name, kind: 'signal', output });

/** `n` settled children of the unbounded fan at seq 0 of `parent`, one checkpoint each. */
function settledChildren(parent: string, n: number, from = 0): StepCheckpoint[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return instantCheckpoint({
      runId: parent,
      seq: i,
      name: `signal:child:${parent}.all.0.${i}`,
      kind: 'signal',
      output: { ok: true, value: i },
      parallelGroup: 'all:0:n40000',
    });
  });
}

async function bufferChildren(store: InMemoryStateStore, ids: string[], value = (i: number) => i) {
  for (const id of ids) {
    const i = Number(id.slice(id.lastIndexOf('.') + 1));
    await store.bufferSignal(`child:${id}`, { ok: true, value: value(i) });
  }
}

async function bufferedCount(store: InMemoryStateStore): Promise<number> {
  return (await store.listBufferedSignals('child:', undefined, 1_000_000)).length;
}

/** Sweep calls until the backlog is gone (or `max` calls), asserting each page's cost. */
async function drain(
  engine: WorkflowEngine,
  counted: ReturnType<typeof counting>,
  maxCallsPerPage: number,
  max = 100,
): Promise<{ deleted: number; pages: number; calls: number }> {
  let deleted = 0;
  let pages = 0;
  let calls = 0;
  for (let call = 0; call < max; call++) {
    counted.reset();
    const n = await engine.sweepBufferedSignals(0, Number.POSITIVE_INFINITY);
    const p = counted.pages();
    if (p === 0) break;
    expect(counted.nameReads()).toEqual([]);
    expect(counted.calls.length).toBeLessThanOrEqual(maxCallsPerPage * p);
    deleted += n;
    pages += p;
    calls += counted.calls.length;
    if (n === 0 && p < 4) break;
  }
  return { deleted, pages, calls };
}

describe('sweepBufferedSignals reads a page set-based, not per row', () => {
  it('[sweep-cost] a running parent with a 40k-child folded fan, 20k completions buffered', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoint(
      cp('p', 0, 'fan:p.all.0.', { from: 0, values: Array.from({ length: 40_000 }, (_, i) => i) }),
    );
    await bufferChildren(
      inner,
      Array.from({ length: 20_000 }, (_, i) => `p.all.0.${10_000 + i}`),
    );
    const counted = counting(inner);
    const engine = new WorkflowEngine({ store: counted.store });

    const { deleted, pages } = await drain(engine, counted, 8);

    expect(deleted).toBe(20_000);
    expect(pages).toBeGreaterThanOrEqual(20_000 / PAGE);
    expect(await bufferedCount(inner)).toBe(0);
  });

  it('[sweep-cost] the same fan in waves of 1000, every wave folded at its first seq', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('q'));
    for (let k = 0; k < 40; k++) {
      await inner.saveCheckpoint(
        cp('q', 3 + k * 1_000, `fan:q.all.3.w${k}.`, {
          from: k * 1_000,
          values: Array.from({ length: 1_000 }, (_, j) => j),
        }),
      );
    }
    await bufferChildren(
      inner,
      Array.from({ length: 20_000 }, (_, n) => {
        const i = 10_000 + n;
        return `q.all.3.w${Math.floor(i / 1_000)}.${i}`;
      }),
    );
    const counted = counting(inner);
    const engine = new WorkflowEngine({ store: counted.store });

    const { deleted } = await drain(engine, counted, 8);

    expect(deleted).toBe(20_000);
    expect(await bufferedCount(inner)).toBe(0);
  });

  it('[sweep-cost] 500 rows of a parent with 40k per-child checkpoints: a few calls, no read by name', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoints(settledChildren('p', 40_000));
    await bufferChildren(
      inner,
      Array.from({ length: 500 }, (_, i) => `p.all.0.${20_000 + i}`),
    );
    const { store, calls, reset, nameReads } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(500);

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(await bufferedCount(inner)).toBe(0);
  });

  it('[sweep-cost] keeps the rows a live parent has not settled, and decides them as cheaply', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoints(settledChildren('p', 20_000));
    // 250 settled (doomed), 250 the parent has no checkpoint for yet (kept), 10 settled differently.
    await bufferChildren(inner, [
      ...Array.from({ length: 250 }, (_, i) => `p.all.0.${10_000 + i}`),
      ...Array.from({ length: 250 }, (_, i) => `p.all.0.${30_000 + i}`),
    ]);
    await bufferChildren(
      inner,
      Array.from({ length: 10 }, (_, i) => `p.all.0.${i}`),
      () => -1,
    );
    const { store, calls, reset, nameReads } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(250);

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(8); // two pages
    expect(await bufferedCount(inner)).toBe(260);
  });

  it('[sweep-cost] rows of a gone or finished parent go without any checkpoint read', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('done', 'completed'));
    await bufferChildren(inner, [
      ...Array.from({ length: 200 }, (_, i) => `done.all.0.${i}`),
      ...Array.from({ length: 200 }, (_, i) => `gone.all.0.${i}`),
    ]);
    const { store, calls, reset } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(400);

    expect(calls.filter((c) => c.toLowerCase().includes('checkpoint'))).toEqual([]);
  });

  it('[sweep-budget] one call stops at its time budget and the next resumes where it stopped', async () => {
    const inner = new InMemoryStateStore();
    // 500 rows of 500 different live parents: the worst case, one checkpoint read per parent.
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      await inner.createRun(parentRun(`p${i}`));
      await inner.saveCheckpoints(settledChildren(`p${i}`, 1, 3));
      ids.push(`p${i}.all.0.3`);
    }
    await bufferChildren(inner, ids);
    const { store } = counting(inner, 2);
    const engine = new WorkflowEngine({ store });

    const started = Date.now();
    const first = await engine.sweepBufferedSignals();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(800);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(500);
    let total = first;
    for (let call = 0; call < 100 && total < 500; call++) {
      total += await engine.sweepBufferedSignals();
    }
    expect(total).toBe(500);
    expect(await bufferedCount(inner)).toBe(0);
  }, 20_000);

  it('[sweep-budget] a call made while another runs does nothing', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoints(settledChildren('p', 10));
    await bufferChildren(
      inner,
      Array.from({ length: 10 }, (_, i) => `p.all.0.${i}`),
    );
    const { store } = counting(inner, 20);
    const engine = new WorkflowEngine({ store });

    const [a, b] = await Promise.all([
      engine.sweepBufferedSignals(),
      engine.sweepBufferedSignals(),
    ]);

    expect(a).toBe(10);
    expect(b).toBe(0);
  });
});

describe('childCompletionNeedsBuffer on the write path', () => {
  it('[write-cost] costs a fixed number of key reads per completion of a 10k fan', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    // The first half settled; the second half not yet.
    await inner.saveCheckpoints(settledChildren('p', 5_000));
    const { store, calls, reset, nameReads } = counting(inner);
    reset();

    const needed: boolean[] = [];
    for (let i = 0; i < 10_000; i++) {
      needed.push(await childCompletionNeedsBuffer(store, `p.all.0.${i}`, { ok: true, value: i }));
    }

    expect(needed.slice(0, 5_000).every((n) => n === false)).toBe(true);
    expect(needed.slice(5_000).every((n) => n === true)).toBe(true);
    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(2 * 10_000);
  });

  it('[write-cost] a child of a folded 10k fan is settled from the fold by key', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoint(
      cp('p', 0, 'fan:p.all.0.', { from: 0, values: Array.from({ length: 10_000 }, (_, i) => i) }),
    );
    const { store, calls, reset, nameReads } = counting(inner);
    reset();

    for (let i = 0; i < 10_000; i += 97) {
      expect(await childCompletionNeedsBuffer(store, `p.all.0.${i}`, { ok: true, value: i })).toBe(
        false,
      );
    }

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(2 * Math.ceil(10_000 / 97));
  });

  it('[write-cost] a child of a fan in waves whose wave folded is settled without a read by name', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('q'));
    for (let k = 0; k < 10; k++) {
      await inner.saveCheckpoint(
        cp('q', k * 1_000, `fan:q.all.0.w${k}.`, {
          from: k * 1_000,
          values: Array.from({ length: 1_000 }, (_, j) => j),
        }),
      );
    }
    const { store, calls, reset, nameReads } = counting(inner);
    reset();

    expect(await childCompletionNeedsBuffer(store, 'q.all.0.w4.4321', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe('childCompletionNeedsBuffer reads by name only when the child id names no seq', () => {
  async function parentWith(id: string, checkpoints: StepCheckpoint[]) {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun(id));
    await inner.saveCheckpoints(checkpoints);
    const counted = counting(inner);
    counted.reset();
    return counted;
  }

  it('a ctx.startChild child, settled at a later seq than its spawn', async () => {
    const { store, nameReads } = await parentWith('s', [
      cp('s', 0, 'spawn:s.child.0', 's.child.0'),
      cp('s', 4, 'signal:child:s.child.0', { ok: true, value: 'x' }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 's.child.0', { ok: true, value: 'x' })).toBe(
      false,
    );
    expect(await childCompletionNeedsBuffer(store, 's.child.0', { ok: true, value: 'y' })).toBe(
      true,
    );
    expect(nameReads()).toHaveLength(2);
  });

  it('a ctx.child child with nothing at its seq is not settled, without a read by name', async () => {
    const { store, nameReads } = await parentWith('c', [
      cp('c', 0, 'signal:child:c.child.0', { ok: true, value: 1 }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'c.child.3', { ok: true, value: 1 })).toBe(true);
    expect(await childCompletionNeedsBuffer(store, 'c.child.0', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
  });

  it('a fan child past what the fold covers is not settled', async () => {
    const { store, nameReads } = await parentWith('f', [
      cp('f', 0, 'fan:f.all.0.', { from: 0, values: Array.from({ length: 100 }, (_, i) => i) }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'f.all.0.150', { ok: true, value: 1 })).toBe(
      true,
    );
    expect(await childCompletionNeedsBuffer(store, 'f.all.0.99', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
  });

  it('a fan in waves whose wave 0 did not fold falls back to the read by name', async () => {
    const { store, nameReads } = await parentWith('w', [
      cp('w', 0, 'signal:child:w.all.0.w0.0', { ok: false, error: 'boom' }),
      cp('w', 20, 'fan:w.all.0.w2.', { from: 20, values: Array.from({ length: 10 }, (_, i) => i) }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'w.all.0.w2.25', { ok: true, value: 5 })).toBe(
      false,
    );
    expect(await childCompletionNeedsBuffer(store, 'w.all.0.w3.35', { ok: true, value: 5 })).toBe(
      true,
    );
    expect(nameReads()).toHaveLength(2);
  });

  it('an onError handler, whose id names no seq', async () => {
    const { store } = await parentWith('o', [
      cp('o', 7, 'signal:child:o.onError.1', { ok: true, value: 'handled' }),
    ]);
    expect(
      await childCompletionNeedsBuffer(store, 'o.onError.1', { ok: true, value: 'handled' }),
    ).toBe(false);
    expect(await childCompletionNeedsBuffer(store, 'o.onError.2', { ok: true, value: 'x' })).toBe(
      true,
    );
  });

  it('a completion that cannot be compared (a BigInt) is kept', async () => {
    const { store } = await parentWith('b', [
      cp('b', 0, 'signal:child:b.child.0', { ok: true, value: 1 }),
    ]);
    expect(
      await childCompletionNeedsBuffer(store, 'b.child.0', { ok: true, value: BigInt(1) }),
    ).toBe(true);
  });
});

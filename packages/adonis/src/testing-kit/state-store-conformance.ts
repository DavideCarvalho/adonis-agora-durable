import { beforeEach, describe, expect, it } from 'vitest';
import {
  type RunStatus,
  type ScheduleQuery,
  type ScheduleRecord,
  type StateStore,
  type StepCheckpoint,
  type StepSettlement,
  WorkflowEngine,
  type WorkflowRun,
} from '../index.js';
import { registerCheckpointAggregationCases } from './checkpoint-aggregation-contract.js';

/**
 * A freshly provisioned, empty {@link StateStore} plus a `cleanup` to release its resources (close
 * the connection, drop the schema, etc.). The conformance suite asks for one before each test so
 * every case starts from a clean slate — exactly like the per-store specs that build a `:memory:` DB.
 */
export interface StateStoreContext {
  store: StateStore;
  cleanup: () => Promise<void>;
  /**
   * Whether the store's optional `transaction` can run an ASYNC work callback. Defaults to `true`.
   * Set `false` only for a driver that genuinely can't — e.g. Drizzle on the SYNCHRONOUS
   * `better-sqlite3` driver, whose `transaction()` rejects a promise-returning callback ("Transaction
   * function cannot return a promise"). The same Drizzle adapter on an async driver (libSQL) works,
   * and the contract still asserts `transaction` for every other store, so this never hides drift.
   */
  supportsAsyncTransaction?: boolean;
  /**
   * Whether the store can filter `listRuns({ tag })`. Defaults to `true`. Set `false` ONLY for
   * Prisma-on-SQLite: the Prisma adapter filters tags with the `array_contains` JSON predicate, which
   * Prisma supports on its real targets (Postgres + MySQL) but NOT on SQLite. SQLite is only the
   * adapter's local TEST database, so the tag case is skipped there; every other store (and Prisma on
   * a real engine) still asserts it, so this doesn't hide drift in the supported configurations.
   */
  supportsTagFilter?: boolean;
  /**
   * How many statements the store has sent its database so far, for the cases that bound what an
   * engine operation costs (e.g. a SQL store counting its client's `query` events). Omit it for a
   * store with no statements to count; those cases are then skipped.
   */
  statements?: () => number;
}

/** Builds a fresh, empty store for one test. Called once per `it` (in `beforeEach`). */
export type StateStoreFactory = () => Promise<StateStoreContext>;

/**
 * Thrown by a {@link StateStoreFactory} to SKIP the contract for an unavailable backend instead of
 * failing it — e.g. a testcontainers DB spec when Docker isn't running. Every contract case catches
 * it, logs once, and returns (a no-op pass), so `pnpm test:db` is green-with-skips off a dev box
 * without Docker rather than red.
 */
export class StateStoreUnavailableError extends Error {
  readonly isStateStoreUnavailable = true;
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreUnavailableError';
  }
}

function isUnavailable(err: unknown): err is StateStoreUnavailableError {
  return !!err && typeof err === 'object' && 'isStateStoreUnavailable' in err;
}

const at = new Date('2026-06-11T00:00:00.000Z');

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

const checkpoint = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq: 0,
  name: 'reserve',
  kind: 'local',
  stepId: 'r1:0',
  status: 'completed',
  output: { ok: true },
  attempts: 1,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
  ...over,
});

/**
 * The SHARED behavioral contract every `StateStore` must satisfy — in-memory and each ORM adapter
 * alike. Registered as a vitest `describe`; pass a `name` and a {@link StateStoreFactory} that builds
 * a fresh, empty store. The same assertions run against SQLite/in-memory under `pnpm test` and
 * against real Postgres/MySQL (via testcontainers) under `pnpm test:db`, so any drift between an
 * adapter and the canonical (in-memory) semantics — especially the search-attribute side-table
 * pushdown, which is implemented per-store — fails here instead of silently in production.
 *
 * Each adapter's own spec keeps its dialect-specific tests (DDL/longtext/EXISTS-SQL/JSON-tolerance);
 * this suite owns the cross-store behavior so those never drift apart.
 */
export function runStateStoreContract(name: string, makeStore: StateStoreFactory): void {
  describe(`StateStore contract: ${name}`, () => {
    let store: StateStore;
    let cleanup: (() => Promise<void>) | undefined;
    let supportsAsyncTransaction = true;
    let supportsTagFilter = true;
    let statements: (() => number) | undefined;
    let skipReason: string | undefined;
    let loggedSkip = false;

    beforeEach(async () => {
      try {
        const ctx = await makeStore();
        store = ctx.store;
        cleanup = ctx.cleanup;
        supportsAsyncTransaction = ctx.supportsAsyncTransaction ?? true;
        supportsTagFilter = ctx.supportsTagFilter ?? true;
        statements = ctx.statements;
        skipReason = undefined;
      } catch (err) {
        if (isUnavailable(err)) {
          // Backend unavailable (e.g. no Docker for a testcontainers spec): skip — don't fail.
          skipReason = err.message;
          if (!loggedSkip) {
            console.warn(`[state-store-contract] SKIPPING "${name}": ${skipReason}`);
            loggedSkip = true;
          }
          return;
        }
        throw err;
      }
      return async () => {
        await cleanup?.();
      };
    });

    /** Register a contract case that no-ops (passes) when the backend was reported unavailable.
     *  `timeoutMs` widens the runner's per-test timeout for a case that does many round-trips. */
    const t = (label: string, fn: () => Promise<void>, timeoutMs?: number): void => {
      it(
        label,
        async () => {
          if (skipReason) return;
          await fn();
        },
        timeoutMs,
      );
    };

    // ---- create / get / update --------------------------------------------------------------

    t('creates a run and reads it back with its JSON input', async () => {
      await store.createRun(run());
      const loaded = await store.getRun('r1');
      expect(loaded?.workflow).toBe('checkout');
      expect(loaded?.input).toEqual({ orderId: 'o1' });
    });

    t('returns null for a missing run', async () => {
      expect(await store.getRun('nope')).toBeNull();
    });

    t(
      'lists buffered signals by token prefix in insertion order, a page at a time (when implemented)',
      async () => {
        if (!store.listBufferedSignals) return;
        const list = (prefix: string, after: string | undefined, limit: number) =>
          store.listBufferedSignals?.(prefix, after, limit) ?? Promise.resolve([]);
        await store.bufferSignal('child:a', { ok: true, value: { n: 1 } });
        await store.bufferSignal('order:1', { paid: true });
        await store.bufferSignal('child:b', { ok: false, error: 'x' });
        await store.bufferSignal('child:a', { ok: true, value: { n: 2 } });
        // `_` and `%` in a prefix are literal, not LIKE wildcards.
        await store.bufferSignal('wake_x:1', null);
        await store.bufferSignal('wakeyx:1', null);

        const all = await list('child:', undefined, 10);
        expect(all.map((r) => [r.token, r.payload])).toEqual([
          ['child:a', { ok: true, value: { n: 1 } }],
          ['child:b', { ok: false, error: 'x' }],
          ['child:a', { ok: true, value: { n: 2 } }],
        ]);
        expect(all.map((r) => typeof r.id)).toEqual(['string', 'string', 'string']);
        const first = await list('child:', undefined, 2);
        expect(first.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
        const rest = await list('child:', first.at(-1)?.id, 2);
        expect(rest.map((r) => r.id)).toEqual([all[2]?.id]);
        expect(await list('child:', all[2]?.id, 2)).toEqual([]);
        expect((await list('wake_x:', undefined, 10)).map((r) => r.token)).toEqual(['wake_x:1']);
      },
    );

    t(
      'deletes buffered signals by id and leaves the rest in FIFO order (when implemented)',
      async () => {
        if (!store.listBufferedSignals || !store.deleteBufferedSignals) return;
        await store.bufferSignal('child:a', { n: 1 });
        await store.bufferSignal('child:a', { n: 2 });
        await store.bufferSignal('child:a', { n: 3 });
        await store.bufferSignal('child:b', { n: 4 });
        const rows = await store.listBufferedSignals('child:', undefined, 10);
        await store.deleteBufferedSignals([
          rows[1]?.id as string,
          rows[3]?.id as string,
          '999999999',
        ]);
        await store.deleteBufferedSignals([]);
        expect(await store.takeBufferedSignal('child:a')).toEqual({ payload: { n: 1 } });
        expect(await store.takeBufferedSignal('child:a')).toEqual({ payload: { n: 3 } });
        expect(await store.takeBufferedSignal('child:a')).toBeNull();
        expect(await store.takeBufferedSignal('child:b')).toBeNull();
      },
    );

    t(
      'a sweep of buffered child completions sends a few statements per page, not one per row',
      async () => {
        if (!statements || !store.listBufferedSignals || !store.deleteBufferedSignals) return;
        if (!store.saveCheckpoints) return;
        // A wide fan's parent, still open, that has settled every child whose completion is still
        // buffered: the rows must go, decided without one checkpoint read per row.
        const parent = 'wide';
        await store.createRun(run({ id: parent, status: 'suspended' }));
        const fan = 4_000;
        for (let from = 0; from < fan; from += 500) {
          await store.saveCheckpoints(
            Array.from({ length: 500 }, (_, k) => {
              const i = from + k;
              return checkpoint({
                runId: parent,
                seq: i,
                stepId: `${parent}:${i}`,
                name: `signal:child:${parent}.all.0.${i}`,
                kind: 'signal',
                output: { ok: true, value: { i } },
                parallelGroup: `all:0:n${fan}`,
              });
            }),
          );
        }
        const rows = 500;
        for (let k = 0; k < rows; k += 1) {
          const i = 2_000 + k;
          await store.bufferSignal(`child:${parent}.all.0.${i}`, { ok: true, value: { i } });
        }
        const engine = new WorkflowEngine({ store });

        const before = statements();
        const deleted = await engine.sweepBufferedSignals(Date.now(), Number.POSITIVE_INFINITY);
        const sent = statements() - before;

        expect(deleted).toBe(rows);
        expect(await store.listBufferedSignals('child:', undefined, 10)).toEqual([]);
        // The page, the parent's run row, its checkpoints by seq, the delete, the next (empty) page:
        // a few statements each, against one per buffered row.
        expect(sent).toBeLessThanOrEqual(10);
      },
      60_000,
    );

    t(
      'a parent joining children that already finished settles them from their rows',
      async () => {
        const engine = new WorkflowEngine({ store, reconcileMs: 0 });
        engine.register('j-child', '1', async (_ctx, input) => ({ n: (input as { n: number }).n }));
        engine.register('j-parent', '1', async (ctx) => {
          const lone = await ctx.child('j-child', { n: 9 }, 'j-own-id');
          const fan = await ctx.allSettled('j-child', [{ n: 0 }, { n: 1 }]);
          return { lone, fan };
        });
        // Both finish before the parent exists: their notifications find no waiter.
        await engine.start('j-child', { n: 9 }, 'j-own-id');
        await engine.start('j-child', { n: 1 }, 'jp.all.1.1');
        expect((await engine.waitForRun('j-own-id', { timeoutMs: 20_000 })).status).toBe(
          'completed',
        );
        expect((await engine.waitForRun('jp.all.1.1', { timeoutMs: 20_000 })).status).toBe(
          'completed',
        );
        await engine.start('j-parent', {}, 'jp');
        const deadline = Date.now() + 20_000;
        while ((await store.getRun('jp'))?.status !== 'completed') {
          if (Date.now() > deadline) throw new Error('parent never completed');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect((await store.getRun('jp'))?.output).toEqual({
          lone: { n: 9 },
          fan: [
            { status: 'fulfilled', value: { n: 0 } },
            { status: 'fulfilled', value: { n: 1 } },
          ],
        });
        await engine.drain(5_000);
      },
      60_000,
    );

    t('round-trips a refused wake request (wakeRequestedAt), and clears it', async () => {
      await store.createRun(run({ status: 'suspended' }));
      await store.updateRun('r1', { wakeRequestedAt: 1234 });
      expect((await store.getRun('r1'))?.wakeRequestedAt).toBe(1234);
      expect(await store.updateRunIf('r1', ['suspended'], { wakeRequestedAt: 99 })).toBe(true);
      expect((await store.getRun('r1'))?.wakeRequestedAt).toBe(99);
      await store.updateRun('r1', { wakeRequestedAt: undefined });
      expect((await store.getRun('r1'))?.wakeRequestedAt).toBeUndefined();
    });

    t('a suspended run that asked for a turn is due, whatever its timer says', async () => {
      const far = 9_999_999_999_999;
      await store.createRun(run({ id: 'asked', status: 'suspended', wakeAt: far }));
      await store.createRun(run({ id: 'untimed', status: 'suspended' }));
      await store.createRun(run({ id: 'quiet', status: 'suspended', wakeAt: far }));
      await store.createRun(run({ id: 'busy', status: 'running' }));
      await store.updateRun('asked', { wakeRequestedAt: 1 });
      await store.updateRun('untimed', { wakeRequestedAt: 1 });
      await store.updateRun('busy', { wakeRequestedAt: 1 });
      const due = (await store.listDueTimers(1_000)).map((r) => r.id).sort();
      expect(due).toEqual(['asked', 'untimed']);
    });

    t(
      'releaseRunLockUnlessWakeRequested (when implemented) keeps the lease while a turn is asked for',
      async () => {
        if (!store.releaseRunLockUnlessWakeRequested) return;
        await store.createRun(run({ status: 'suspended' }));
        expect(await store.tryLockRun('r1', 'holder', 10_000, 0)).toBe(true);
        expect(await store.releaseRunLockUnlessWakeRequested('r1', 'holder')).toBe(true);
        expect((await store.getRun('r1'))?.lockedBy).toBeUndefined();

        expect(await store.tryLockRun('r1', 'holder', 10_000, 0)).toBe(true);
        await store.updateRun('r1', { wakeRequestedAt: 5 });
        expect(await store.releaseRunLockUnlessWakeRequested('r1', 'holder')).toBe(false);
        expect((await store.getRun('r1'))?.lockedBy).toBe('holder');

        // Not the holder: nothing to release, and the holder's lease stays.
        expect(await store.releaseRunLockUnlessWakeRequested('r1', 'someone-else')).toBe(true);
        expect((await store.getRun('r1'))?.lockedBy).toBe('holder');

        await store.updateRun('r1', { wakeRequestedAt: undefined });
        expect(await store.releaseRunLockUnlessWakeRequested('r1', 'holder')).toBe(true);
        expect((await store.getRun('r1'))?.lockedBy).toBeUndefined();
      },
    );

    t(
      'getRuns (when implemented) reads several runs at once, leaving out unknown ids',
      async () => {
        if (!store.getRuns) return;
        await store.createRun(run());
        await store.createRun(
          run({ id: 'r2', status: 'completed', input: { orderId: 'o2' }, output: { total: 2 } }),
        );
        expect(await store.getRuns([])).toEqual([]);
        const got = (await store.getRuns(['r2', 'nope', 'r1', 'r2'])).sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        expect(got.map((r) => r.id)).toEqual(['r1', 'r2']);
        expect(got[0]?.input).toEqual({ orderId: 'o1' });
        expect(got[1]?.status).toBe('completed');
        expect(got[1]?.output).toEqual({ total: 2 });
        // The same run as getRun reads it.
        expect(got[1]).toEqual(await store.getRun('r2'));
      },
    );

    t(
      'createRun rejects a duplicate id (the engine converges racing starts on the winner)',
      async () => {
        await store.createRun(run({ status: 'completed', output: { total: 1 } }));
        await expect(store.createRun(run())).rejects.toThrow();
        // The winner's state was not clobbered by the losing insert.
        const winner = await store.getRun('r1');
        expect(winner?.status).toBe('completed');
        expect(winner?.output).toEqual({ total: 1 });
      },
    );

    t('updates a run (status/output) and round-trips recoveryAttempts + dead status', async () => {
      await store.createRun(run({ recoveryAttempts: 3 }));
      await store.updateRun('r1', {
        status: 'completed',
        output: { total: 42 },
        updatedAt: at,
      });
      const done = await store.getRun('r1');
      expect(done?.status).toBe('completed');
      expect(done?.output).toEqual({ total: 42 });
      expect(done?.recoveryAttempts).toBe(3);

      await store.updateRun('r1', { status: 'dead', recoveryAttempts: 4 });
      const dead = await store.getRun('r1');
      expect(dead?.status).toBe('dead');
      expect(dead?.recoveryAttempts).toBe(4);
    });

    t('deleteRun removes the run and all its rows (checkpoints, waiters, attributes)', async () => {
      await store.createRun(run({ searchAttributes: { tier: 'pro' } }));
      await store.saveCheckpoint(checkpoint());
      await store.putSignalWaiter({ token: 'approve-r1', runId: 'r1', seq: 0 });

      await store.deleteRun('r1');

      // The run and every child row are gone — not merely marked terminal.
      expect(await store.getRun('r1')).toBeNull();
      expect(await store.listCheckpoints('r1')).toEqual([]);
      expect(await store.listSignalWaiters('approve-')).toEqual([]);
      // The normalized attribute side-table no longer matches it.
      expect(
        await store.listRuns({
          attributes: [{ key: 'tier', op: 'eq', value: 'pro' }],
        }),
      ).toEqual([]);
    });

    t('deleteRun is a no-op for a missing run', async () => {
      await expect(store.deleteRun('nope')).resolves.toBeUndefined();
    });

    t(
      'updateRun maps every patchable field — clears error and patches tags/lockedBy/input/timers',
      async () => {
        // Guards against per-adapter patch-whitelist drift: a store that maps only a subset of fields
        // (or ignores `undefined` instead of clearing) would silently no-op these and fail here.
        await store.createRun(
          run({ status: 'failed', error: { message: 'boom' }, tags: ['old'], lockedBy: 'owner-1' }),
        );
        await store.updateRun('r1', {
          status: 'completed',
          output: { ok: true },
          error: undefined, // completion CLEARS the prior error
          input: { orderId: 'o2' },
          tags: ['x', 'y'],
          lockedBy: 'owner-2',
          wakeAt: 123_456,
          lockedUntil: 222_222,
          updatedAt: at,
        });
        const r = await store.getRun('r1');
        expect(r?.status).toBe('completed');
        expect(r?.output).toEqual({ ok: true });
        expect(r?.error).toBeUndefined();
        expect(r?.input).toEqual({ orderId: 'o2' });
        expect(r?.tags).toEqual(['x', 'y']);
        expect(r?.lockedBy).toBe('owner-2');
        expect(r?.wakeAt).toBe(123_456);
        expect(r?.lockedUntil).toBe(222_222);

        // The remote-turn decision marker must round-trip AND clear: the engine sets it when it
        // suspends on a dispatched turn and clears it (`undefined`) when the decision is applied. A
        // store that drops it on read, or ignores `undefined` instead of writing NULL, makes every
        // replica discard the decision (it reads back a stale or absent marker).
        await store.updateRun('r1', { awaitingDecisionTaskId: 'r1:wf:turn-7' });
        expect((await store.getRun('r1'))?.awaitingDecisionTaskId).toBe('r1:wf:turn-7');
        expect(
          await store.updateRunIf('r1', ['completed'], { awaitingDecisionTaskId: undefined }),
        ).toBe(true);
        expect((await store.getRun('r1'))?.awaitingDecisionTaskId).toBeUndefined();
      },
    );

    // ---- updateRunIf (conditional / compare-and-set) ----------------------------------------

    t(
      'updateRunIf applies the patch and returns true when the current status is expected',
      async () => {
        await store.createRun(run({ status: 'running' }));
        const applied = await store.updateRunIf('r1', ['running', 'suspended'] as RunStatus[], {
          status: 'completed',
          output: { ok: true },
          updatedAt: at,
        });
        expect(applied).toBe(true);
        const after = await store.getRun('r1');
        expect(after?.status).toBe('completed');
        expect(after?.output).toEqual({ ok: true });
      },
    );

    t(
      'updateRunIf returns false and leaves the row untouched when the status is not expected',
      async () => {
        await store.createRun(run({ status: 'cancelled', error: { message: 'cancelled' } }));
        const applied = await store.updateRunIf('r1', ['running', 'suspended'] as RunStatus[], {
          status: 'completed',
          output: { ok: true },
          updatedAt: at,
        });
        expect(applied).toBe(false);
        const after = await store.getRun('r1');
        // Untouched: still cancelled, with its original error, no output written.
        expect(after?.status).toBe('cancelled');
        expect(after?.error).toEqual({ message: 'cancelled' });
        expect(after?.output).toBeUndefined();
      },
    );

    t(
      'two sequential updateRunIf calls: once the first transitions the run out of the expected set, the second returns false',
      async () => {
        await store.createRun(run({ status: 'running' }));
        const first = await store.updateRunIf('r1', ['running', 'suspended'] as RunStatus[], {
          status: 'cancelled',
          error: { message: 'cancelled' },
          updatedAt: at,
        });
        expect(first).toBe(true);

        // A second write computed from a stale "running" snapshot must NOT clobber the cancel that
        // just landed — this is the exact property the whole contract addition exists for.
        const second = await store.updateRunIf('r1', ['running', 'suspended'] as RunStatus[], {
          status: 'completed',
          output: { ok: true },
          updatedAt: at,
        });
        expect(second).toBe(false);
        const after = await store.getRun('r1');
        expect(after?.status).toBe('cancelled');
        expect(after?.output).toBeUndefined();
      },
    );

    // ---- tryAdmitSingleton (atomic singleton slots) -----------------------------------------
    // Optional SPI: a store without it can't run singleton workflows, so these cases pass vacuously.

    const ADMITTED = 'durable:singleton:admitted';
    const TRACKED = 'durable:singleton:tracked';
    const gated = (id: string, createdMs: number, over: Partial<WorkflowRun> = {}): WorkflowRun =>
      run({
        id,
        workflow: 'job',
        status: 'running',
        // `running` and tracked: the engine stamps the tracked marker on a singleton run's first
        // execution, before it claims (an untracked, untagged running run reads as a pre-0.51 holder).
        tags: ['singleton:k', TRACKED],
        createdAt: new Date(createdMs),
        updatedAt: new Date(createdMs),
        ...over,
      });

    t('tryAdmitSingleton admits the oldest waiter and persists the slot in its tags', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(gated('a', 1000));
      await store.createRun(gated('b', 2000));
      expect(await store.tryAdmitSingleton('b', 'singleton:k', 'job', 1, 5000)).toBe(false);
      expect(await store.tryAdmitSingleton('a', 'singleton:k', 'job', 1, 5000)).toBe(true);
      expect((await store.getRun('a'))?.tags).toEqual(['singleton:k', ADMITTED]);
      // The denied waiter was parked on its retry timer, in the same claim.
      const parked = await store.getRun('b');
      expect(parked?.status).toBe('suspended');
      expect(parked?.wakeAt).toBe(5000);
      // A holder re-checking (a resumed turn) keeps its slot.
      expect(await store.tryAdmitSingleton('a', 'singleton:k', 'job', 1, 5000)).toBe(true);
    });

    t('tryAdmitSingleton never lets a later or same-instant run displace a holder', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(gated('z-holder', 1000, { tags: ['singleton:k', ADMITTED] }));
      // Same createdAt, smaller id: it would sort first in a positional scan.
      await store.createRun(gated('a-waiter', 1000));
      expect(await store.tryAdmitSingleton('a-waiter', 'singleton:k', 'job', 1)).toBe(false);
      expect((await store.getRun('a-waiter'))?.tags).toEqual(['singleton:k', TRACKED]);
      // A second slot goes to the waiter.
      expect(await store.tryAdmitSingleton('a-waiter', 'singleton:k', 'job', 2)).toBe(true);
    });

    t('tryAdmitSingleton scopes slots to the workflow and the key', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(gated('other-key', 1000, { tags: ['singleton:x', ADMITTED] }));
      await store.createRun(
        gated('other-wf', 1000, { workflow: 'job2', tags: ['singleton:k', ADMITTED] }),
      );
      await store.createRun(gated('mine', 2000));
      expect(await store.tryAdmitSingleton('mine', 'singleton:k', 'job', 1)).toBe(true);
    });

    t('tryAdmitSingleton never parks a run a concurrent cancel already settled', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(
        gated('holder', 1000, { status: 'suspended', tags: ['singleton:k', ADMITTED] }),
      );
      await store.createRun(gated('cancelled', 2000, { status: 'cancelled' }));
      expect(await store.tryAdmitSingleton('cancelled', 'singleton:k', 'job', 1, 5000)).toBe(false);
      const after = await store.getRun('cancelled');
      expect(after?.status).toBe('cancelled');
      expect(after?.wakeAt).toBeUndefined();
      expect(await store.tryAdmitSingleton('missing', 'singleton:k', 'job', 1, 5000)).toBe(false);
    });

    t('a terminal settle releases the slot; non-terminal writes keep it', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(gated('a', 1000));
      expect(await store.tryAdmitSingleton('a', 'singleton:k', 'job', 1)).toBe(true);
      await store.updateRun('a', { status: 'suspended', wakeAt: 9000 });
      expect((await store.getRun('a'))?.tags).toContain(ADMITTED);
      await store.updateRun('a', { status: 'failed', error: { message: 'x' } });
      expect((await store.getRun('a'))?.tags).toEqual(['singleton:k']);
      await store.createRun(gated('b', 2000));
      expect(await store.tryAdmitSingleton('b', 'singleton:k', 'job', 1)).toBe(true);
      expect(await store.updateRunIf('b', ['running'], { status: 'completed' })).toBe(true);
      expect((await store.getRun('b'))?.tags).toEqual(['singleton:k']);
    });

    // A replica older than 0.51 admits by a scan (the `limit` oldest running/suspended runs of the
    // key) and writes no admission tag. During a rolling upgrade such a holder still occupies its
    // slot for the new replicas.
    t('tryAdmitSingleton counts an untagged pre-0.51 holder (rolling upgrade)', async () => {
      if (!store.tryAdmitSingleton) return;
      const claim = (id: string, wakeAt?: number) =>
        store.tryAdmitSingleton?.(id, 'singleton:k', 'job', 1, wakeAt);
      // Written by an old replica: admitted by its scan, running, no tag at all. It is NEWER than the
      // run below, which was still `pending` (invisible to the old scan) back then.
      await store.createRun(gated('legacy', 2000, { tags: ['singleton:k'] }));
      // The older run, now picked up by a new replica: tracked from its first execution.
      await store.createRun(gated('new', 1000));
      expect(await claim('new', 12_000)).toBe(false);
      expect(await store.getRun('new')).toMatchObject({ status: 'suspended', wakeAt: 12_000 });
      expect((await store.getRun('new'))?.tags).toContain(TRACKED);
      // A legacy holder parked on its own sleep still holds the slot.
      await store.updateRun('legacy', { status: 'suspended', wakeAt: 20_000 });
      expect(await claim('new')).toBe(false);
      // Once it settles, the new admission takes over, swapping the marker for the admitted tag.
      await store.updateRun('legacy', { status: 'completed' });
      expect(await claim('new')).toBe(true);
      expect((await store.getRun('new'))?.tags).toEqual(['singleton:k', ADMITTED]);
      await store.updateRun('new', { status: 'completed' });
      expect((await store.getRun('new'))?.tags).toEqual(['singleton:k']);
    });

    t('legacy singleton waiters keep their FIFO place across the upgrade', async () => {
      if (!store.tryAdmitSingleton) return;
      const claim = (id: string, wakeAt?: number) =>
        store.tryAdmitSingleton?.(id, 'singleton:k', 'job', 1, wakeAt);
      await store.createRun(gated('holder', 1000, { tags: ['singleton:k'] }));
      // Denied by an old replica: suspended on its retry timer, no tag.
      await store.createRun(
        gated('old-waiter', 2000, { status: 'suspended', wakeAt: 5_000, tags: ['singleton:k'] }),
      );
      await store.createRun(gated('new-run', 3000));
      expect(await claim('new-run')).toBe(false);
      expect(await claim('old-waiter')).toBe(false);
      // A legacy waiter re-checked by a new replica is tracked from then on; it keeps its place.
      expect(await claim('old-waiter', 6_000)).toBe(false);
      expect((await store.getRun('old-waiter'))?.tags).toContain(TRACKED);
      await store.updateRun('holder', { status: 'completed' });
      expect(await claim('new-run')).toBe(false);
      expect(await claim('old-waiter')).toBe(true);
      expect(await claim('new-run')).toBe(false);
      await store.updateRun('old-waiter', { status: 'completed' });
      expect(await claim('new-run')).toBe(true);
    });

    t('concurrent claims never over-admit beside an untagged legacy holder', async () => {
      if (!store.tryAdmitSingleton) return;
      await store.createRun(gated('legacy', 1000, { tags: ['singleton:k'] }));
      const ids = ['c1', 'c2', 'c3', 'c4'];
      for (const [i, id] of ids.entries()) await store.createRun(gated(id, 2000 + i * 1000));
      const results = await Promise.all(
        [...ids].reverse().map((id) => store.tryAdmitSingleton?.(id, 'singleton:k', 'job', 2)),
      );
      // One slot is the legacy holder's; only the oldest new run takes the other.
      expect(results).toEqual([false, false, false, true]);
      const rows = await Promise.all(ids.map((id) => store.getRun(id)));
      expect(rows.filter((r) => r?.tags?.includes(ADMITTED)).map((r) => r?.id)).toEqual(['c1']);
    });

    t('concurrent claims for one slot admit exactly one run', async () => {
      if (!store.tryAdmitSingleton) return;
      const ids = Array.from({ length: 6 }, (_, i) => `c${i}`);
      // Same createdAt for all, so the claim order is decided only by the store's serialization.
      for (const id of ids) await store.createRun(gated(id, 1000));
      const verdicts = await Promise.all(
        ids.map((id) => store.tryAdmitSingleton?.(id, 'singleton:k', 'job', 1, 5000)),
      );
      expect(verdicts.filter(Boolean)).toHaveLength(1);
      const rows = await Promise.all(ids.map((id) => store.getRun(id)));
      expect(rows.filter((r) => r?.tags?.includes(ADMITTED))).toHaveLength(1);
    });

    // ---- checkpoints ------------------------------------------------------------------------

    t('countCheckpoints counts a seq range by status', async () => {
      // Optional on the interface (the engine has a fallback), but a conformant store MUST provide
      // it — assert presence, then exercise the fast path.
      expect(store.countCheckpoints).toBeDefined();
      if (!store.countCheckpoints) return;
      await store.createRun(run());
      for (const [seq, status] of [
        [0, 'completed'],
        [1, 'pending'],
        [2, 'pending'],
        [3, 'failed'],
        [4, 'pending'],
      ] as const) {
        await store.saveCheckpoint(checkpoint({ seq, status, stepId: `r1:${seq}` }));
      }
      await store.createRun(run({ id: 'other' }));
      await store.saveCheckpoint(
        checkpoint({ runId: 'other', seq: 2, status: 'pending', stepId: 'other:2' }),
      );

      expect(await store.countCheckpoints('r1', 1, 3, ['pending'])).toBe(2);
      expect(await store.countCheckpoints('r1', 0, 4, ['pending', 'failed'])).toBe(4);
      // Both bounds are inclusive.
      expect(await store.countCheckpoints('r1', 2, 2, ['pending'])).toBe(1);
      expect(await store.countCheckpoints('r1', 1, 4, ['pending'])).toBe(3);
      expect(await store.countCheckpoints('r1', 0, 0, ['completed'])).toBe(1);
      // `other` has a pending row at seq 2: a count is scoped to its run.
      expect(await store.countCheckpoints('other', 0, 4, ['pending'])).toBe(1);
      expect(await store.countCheckpoints('r1', 5, 9, ['pending'])).toBe(0);
      expect(await store.countCheckpoints('r1', 0, 4, [])).toBe(0);
    });

    t('hasCheckpoints answers whether a seq range holds a status', async () => {
      // Optional on the interface (the engine falls back to countCheckpoints), but a conformant store
      // MUST provide it — assert presence, then exercise the fast path.
      expect(store.hasCheckpoints).toBeDefined();
      if (!store.hasCheckpoints) return;
      await store.createRun(run());
      for (const [seq, status] of [
        [0, 'completed'],
        [1, 'pending'],
        [2, 'completed'],
        [3, 'failed'],
        [4, 'completed'],
      ] as const) {
        await store.saveCheckpoint(checkpoint({ seq, status, stepId: `r1:${seq}` }));
      }
      await store.createRun(run({ id: 'other' }));
      await store.saveCheckpoint(
        checkpoint({ runId: 'other', seq: 4, status: 'pending', stepId: 'other:4' }),
      );

      expect(await store.hasCheckpoints('r1', 0, 4, ['pending'])).toBe(true);
      // Both bounds are inclusive.
      expect(await store.hasCheckpoints('r1', 1, 1, ['pending'])).toBe(true);
      expect(await store.hasCheckpoints('r1', 0, 1, ['pending'])).toBe(true);
      expect(await store.hasCheckpoints('r1', 1, 2, ['pending'])).toBe(true);
      expect(await store.hasCheckpoints('r1', 2, 4, ['pending'])).toBe(false);
      expect(await store.hasCheckpoints('r1', 2, 4, ['pending', 'failed'])).toBe(true);
      // `other` has a pending row at seq 4: the answer is scoped to its run.
      expect(await store.hasCheckpoints('r1', 4, 4, ['pending'])).toBe(false);
      expect(await store.hasCheckpoints('other', 0, 9, ['pending'])).toBe(true);
      expect(await store.hasCheckpoints('r1', 5, 9, ['completed'])).toBe(false);
      expect(await store.hasCheckpoints('r1', 0, 4, [])).toBe(false);
    });

    t('saveCheckpointIfPending writes over a pending row only', async () => {
      // Optional on the interface (the engine falls back to a blind save, which can clobber a settled
      // row), but a conformant store MUST provide it — assert presence, then exercise it.
      expect(store.saveCheckpointIfPending).toBeDefined();
      if (!store.saveCheckpointIfPending) return;
      await store.createRun(run());
      const pending = checkpoint({ status: 'pending', output: undefined });
      await store.saveCheckpoint(pending);

      expect(await store.saveCheckpointIfPending({ ...pending, wakeAt: 5_000 })).toBe(true);
      expect((await store.getCheckpoint('r1', 0))?.wakeAt).toBe(5_000);

      const done = { ...pending, status: 'completed' as const, output: { ok: true } };
      expect(await store.saveCheckpointIfPending(done)).toBe(true);
      // A stale pending copy no longer lands on the settled row.
      expect(await store.saveCheckpointIfPending({ ...pending, wakeAt: 9_000 })).toBe(false);
      const after = await store.getCheckpoint('r1', 0);
      expect(after?.status).toBe('completed');
      expect(after?.output).toEqual({ ok: true });
      // The settling write carried no deadline, so the one the pending row held is cleared.
      expect(after?.wakeAt).toBeUndefined();
      // A refused write is refused for every status that is not `pending`, and leaves the row as is.
      await store.saveCheckpoint(
        checkpoint({ seq: 1, status: 'failed', stepId: 'r1:1', error: { message: 'boom' } }),
      );
      expect(await store.saveCheckpointIfPending({ ...pending, seq: 1, stepId: 'r1:1' })).toBe(
        false,
      );
      const failed = await store.getCheckpoint('r1', 1);
      expect(failed?.status).toBe('failed');
      expect(failed?.error?.message).toBe('boom');
      // No row to compare against: nothing is written.
      expect(await store.saveCheckpointIfPending({ ...pending, seq: 9 })).toBe(false);
      expect(await store.getCheckpoint('r1', 9)).toBeNull();
    });

    t('renewCheckpointLease moves a pending row deadline only from the expected one', async () => {
      // Optional on the interface (the engine falls back to saveCheckpointIfPending), so a store
      // without it has nothing to check here.
      if (!store.renewCheckpointLease) return;
      await store.createRun(run());
      const pending = checkpoint({ status: 'pending', output: undefined, attempts: 1 });
      await store.saveCheckpoint(pending);

      // No deadline yet: renews only from "absent".
      expect(await store.renewCheckpointLease('r1', 0, 1_000, 5_000)).toBe(false);
      expect(await store.renewCheckpointLease('r1', 0, undefined, 5_000)).toBe(true);
      expect(await store.getCheckpoint('r1', 0)).toMatchObject({
        status: 'pending',
        wakeAt: 5_000,
      });
      // A stale expectation (someone re-armed it meanwhile) writes nothing.
      expect(await store.renewCheckpointLease('r1', 0, undefined, 9_000)).toBe(false);
      expect(await store.renewCheckpointLease('r1', 0, 5_000, 9_000)).toBe(true);
      const renewed = await store.getCheckpoint('r1', 0);
      // Only the deadline moved.
      expect(renewed).toMatchObject({ status: 'pending', wakeAt: 9_000, attempts: 1 });

      // A settled row is never touched, even with the matching deadline.
      await store.saveCheckpoint({
        ...pending,
        status: 'completed',
        output: { ok: true },
        wakeAt: 9_000,
      });
      expect(await store.renewCheckpointLease('r1', 0, 9_000, 20_000)).toBe(false);
      const settled = await store.getCheckpoint('r1', 0);
      expect(settled).toMatchObject({ status: 'completed', output: { ok: true }, wakeAt: 9_000 });
      // No row: nothing written.
      expect(await store.renewCheckpointLease('r1', 9, undefined, 1)).toBe(false);
      expect(await store.getCheckpoint('r1', 9)).toBeNull();
    });

    t('saveCheckpointsIfPending settles a batch row by row, in order', async () => {
      // Optional on the interface (the engine falls back to one saveCheckpointIfPending per entry),
      // but a conformant store MUST provide it — assert presence, then exercise it.
      expect(store.saveCheckpointsIfPending).toBeDefined();
      if (!store.saveCheckpointsIfPending) return;
      expect(await store.saveCheckpointsIfPending([])).toEqual([]);
      await store.createRun(run());
      await store.createRun(run({ id: 'r2' }));
      const pending = (runId: string, seq: number) =>
        checkpoint({
          runId,
          seq,
          stepId: `${runId}:${seq}`,
          status: 'pending',
          output: undefined,
          wakeAt: 5_000,
        });
      for (const seq of [0, 1, 2, 3]) await store.saveCheckpoint(pending('r1', seq));
      await store.saveCheckpoint(pending('r2', 0));
      // seq 1 already settled: a stale write must not land on it.
      await store.saveCheckpoint({
        ...pending('r1', 1),
        status: 'completed',
        output: { first: 1 },
      });
      const done = (runId: string, seq: number, output: unknown): StepCheckpoint => ({
        ...pending(runId, seq),
        status: 'completed',
        output,
        wakeAt: undefined,
      });

      const wrote = await store.saveCheckpointsIfPending([
        done('r1', 0, { n: 0 }),
        done('r1', 1, { n: 1 }),
        // A second copy of the same row: compared against the first copy's write, so refused.
        done('r1', 0, { n: 'dup' }),
        { ...pending('r1', 2), status: 'failed', error: { message: 'boom' }, wakeAt: undefined },
        // No such row: nothing is written.
        done('r1', 9, { n: 9 }),
        // Another run's row, same seq as one above.
        done('r2', 0, { n: 'r2' }),
      ]);
      expect(wrote).toEqual([true, false, false, true, false, true]);

      const r1 = await store.listCheckpoints('r1');
      expect(r1.map((c) => [c.seq, c.status, c.output])).toEqual([
        [0, 'completed', { n: 0 }],
        [1, 'completed', { first: 1 }],
        [2, 'failed', undefined],
        [3, 'pending', undefined],
      ]);
      expect(r1[2]?.error).toEqual({ message: 'boom' });
      // The settling write carried no deadline, so the one the pending row held is cleared.
      expect(r1[0]?.wakeAt).toBeUndefined();
      expect(r1[3]?.wakeAt).toBe(5_000);
      expect(await store.getCheckpoint('r1', 9)).toBeNull();
      expect((await store.getCheckpoint('r2', 0))?.output).toEqual({ n: 'r2' });

      // A pending-to-pending write keeps the row pending, so a later entry still lands on it.
      expect(
        await store.saveCheckpointsIfPending([
          { ...pending('r1', 3), wakeAt: 9_000 },
          done('r1', 3, { n: 3 }),
        ]),
      ).toEqual([true, true]);
      expect((await store.getCheckpoint('r1', 3))?.output).toEqual({ n: 3 });
    });

    t(
      'settleCheckpointsIfPending writes only the result columns, row by row (when implemented)',
      async () => {
        if (!store.settleCheckpointsIfPending) return;
        expect(await store.settleCheckpointsIfPending([])).toEqual([]);
        await store.createRun(run());
        await store.createRun(run({ id: 'r2' }));
        const pending = (runId: string, seq: number) =>
          checkpoint({
            runId,
            seq,
            stepId: `${runId}:${seq}`,
            status: 'pending',
            input: { prompt: `${runId}:${seq}` },
            output: undefined,
            attempts: 2,
            workerGroup: 'g',
            parallelGroup: 'fan:0:4',
            wakeAt: 5_000,
          });
        for (const seq of [0, 1, 2, 3]) await store.saveCheckpoint(pending('r1', seq));
        await store.saveCheckpoint(pending('r2', 0));
        await store.saveCheckpoint({
          ...pending('r1', 1),
          status: 'completed',
          output: { first: 1 },
        });
        const startedAt = new Date('2026-05-01T00:00:01.000Z');
        const finishedAt = new Date('2026-05-01T00:00:02.000Z');
        const done = (runId: string, seq: number, output: unknown): StepSettlement => ({
          runId,
          seq,
          status: 'completed',
          output,
          events: [{ at: 1, level: 'info', message: `done ${seq}` }],
          startedAt,
          finishedAt,
        });

        const wrote = await store.settleCheckpointsIfPending([
          done('r1', 0, { n: 0 }),
          // Already settled: the result is refused.
          done('r1', 1, { n: 1 }),
          // A second copy of a row settled earlier in the call: refused.
          done('r1', 0, { n: 'dup' }),
          {
            runId: 'r1',
            seq: 2,
            status: 'failed',
            error: { message: 'boom' },
            startedAt,
            finishedAt,
          },
          // No such row: nothing is written.
          done('r1', 9, { n: 9 }),
          done('r2', 0, { n: 'r2' }),
        ]);
        expect(wrote).toEqual([true, false, false, true, false, true]);

        const r1 = await store.listCheckpoints('r1');
        expect(r1.map((c) => [c.seq, c.status, c.output])).toEqual([
          [0, 'completed', { n: 0 }],
          [1, 'completed', { first: 1 }],
          [2, 'failed', undefined],
          [3, 'pending', undefined],
        ]);
        const settled = r1[0] as StepCheckpoint;
        expect(settled.events).toEqual([{ at: 1, level: 'info', message: 'done 0' }]);
        expect(settled.startedAt.getTime()).toBe(startedAt.getTime());
        expect(settled.finishedAt.getTime()).toBe(finishedAt.getTime());
        // Every column the result does not carry is left as it was.
        expect(settled.input).toEqual({ prompt: 'r1:0' });
        expect(settled.attempts).toBe(2);
        expect(settled.workerGroup).toBe('g');
        expect(settled.parallelGroup).toBe('fan:0:4');
        expect(settled.wakeAt).toBe(5_000);
        expect(settled.stepId).toBe('r1:0');
        expect(r1[2]?.error).toEqual({ message: 'boom' });
        expect(r1[2]?.input).toEqual({ prompt: 'r1:2' });
        expect(await store.getCheckpoint('r1', 9)).toBeNull();
        expect((await store.getCheckpoint('r2', 0))?.output).toEqual({ n: 'r2' });

        // One entry alone is the same compare-and-set.
        expect(await store.settleCheckpointsIfPending([done('r1', 3, { n: 3 })])).toEqual([true]);
        expect(await store.settleCheckpointsIfPending([done('r1', 3, { n: 'again' })])).toEqual([
          false,
        ]);
        const third = await store.getCheckpoint('r1', 3);
        expect(third?.output).toEqual({ n: 3 });
        expect(third?.input).toEqual({ prompt: 'r1:3' });
      },
    );

    t(
      'settleCheckpointsIfPending settles a batch wider than one statement (when implemented)',
      async () => {
        if (!store.settleCheckpointsIfPending) return;
        await store.createRun(run());
        const rows = Array.from({ length: 600 }, (_, seq) =>
          checkpoint({
            seq,
            stepId: `r1:${seq}`,
            status: 'pending',
            input: { seq },
            output: undefined,
          }),
        );
        if (store.saveCheckpoints) await store.saveCheckpoints(rows);
        else for (const row of rows) await store.saveCheckpoint(row);
        const at = new Date('2026-05-01T00:00:03.000Z');
        const wrote = await store.settleCheckpointsIfPending(
          rows.map(({ seq }) => ({
            runId: 'r1',
            seq,
            status: 'completed',
            output: seq * 2,
            startedAt: at,
            finishedAt: at,
          })),
        );
        expect(wrote.every((w) => w)).toBe(true);
        const all = await store.listCheckpoints('r1');
        expect(all.every((c, i) => c.status === 'completed' && c.output === i * 2)).toBe(true);
        expect(all.every((c, i) => (c.input as { seq: number }).seq === i)).toBe(true);
      },
      30_000,
    );

    t('getCheckpointsForSettle reads the rows without their input (when implemented)', async () => {
      if (!store.getCheckpointsForSettle) return;
      expect(await store.getCheckpointsForSettle('r1', [])).toEqual([]);
      await store.createRun(run());
      for (const seq of [0, 1, 2]) {
        await store.saveCheckpoint(
          checkpoint({
            seq,
            stepId: `r1:${seq}`,
            status: seq === 0 ? 'completed' : 'pending',
            input: { prompt: `p${seq}` },
            output: seq === 0 ? { a: 0 } : undefined,
            wakeAt: 5_000 + seq,
          }),
        );
      }
      const full = (await store.getCheckpoints?.('r1', [2, 0, 9])) ?? [
        (await store.getCheckpoint('r1', 0)) as StepCheckpoint,
        (await store.getCheckpoint('r1', 2)) as StepCheckpoint,
      ];
      const read = await store.getCheckpointsForSettle('r1', [2, 0, 9]);
      expect(read.map((c) => [c.seq, c.input])).toEqual([
        [0, undefined],
        [2, undefined],
      ]);
      const withoutInput = ({ input: _input, ...rest }: StepCheckpoint) => rest;
      expect(read.map(withoutInput)).toEqual(full.map(withoutInput));
      expect((await store.getCheckpoint('r1', 2))?.input).toEqual({ prompt: 'p2' });
    });

    t(
      "listCheckpointsForReplay leaves out only a completed row's input (when implemented)",
      async () => {
        if (!store.listCheckpointsForReplay) return;
        await store.createRun(run());
        const input = (seq: number) => ({ prompt: `p${seq}` });
        await store.saveCheckpoint(
          checkpoint({ seq: 0, stepId: 'r1:0', input: input(0), output: { a: 0 } }),
        );
        await store.saveCheckpoint(
          checkpoint({
            seq: 1,
            stepId: 'r1:1',
            status: 'pending',
            input: input(1),
            output: undefined,
          }),
        );
        await store.saveCheckpoint(
          checkpoint({
            seq: 2,
            stepId: 'r1:2',
            status: 'failed',
            input: input(2),
            output: undefined,
            error: { message: 'boom' },
            wakeAt: 7_000,
          }),
        );
        await store.saveCheckpoint(
          checkpoint({
            seq: 3,
            stepId: 'r1:3',
            status: 'running',
            input: input(3),
            output: undefined,
          }),
        );
        const full = await store.listCheckpoints('r1');
        const replay = await store.listCheckpointsForReplay('r1');
        expect(replay.map((c) => [c.seq, c.status, c.input])).toEqual([
          [0, 'completed', undefined],
          [1, 'pending', input(1)],
          [2, 'failed', input(2)],
          [3, 'running', input(3)],
        ]);
        // Every other field reads as listCheckpoints reads it.
        const withoutInput = ({ input: _input, ...rest }: StepCheckpoint) => rest;
        expect(replay.map(withoutInput)).toEqual(full.map(withoutInput));
        // The full read still carries every input.
        expect(full.map((c) => c.input)).toEqual([input(0), input(1), input(2), input(3)]);
        expect(await store.listCheckpointsForReplay('nope')).toEqual([]);
      },
    );

    t(
      'saveCheckpoints writes many rows and getCheckpoints reads them back (when implemented)',
      async () => {
        if (!store.saveCheckpoints || !store.getCheckpoints) return;
        await store.createRun(run());
        await store.createRun(run({ id: 'r2' }));
        await store.saveCheckpoints([]);
        expect(await store.getCheckpoints('r1', [])).toEqual([]);
        // Wider than any one statement a store batches, so the batches' seams are crossed.
        const wide = Array.from({ length: 600 }, (_, seq) =>
          checkpoint({ seq, stepId: `r1:${seq}`, status: 'pending', output: undefined }),
        );
        await store.saveCheckpoint(checkpoint({ runId: 'r2', seq: 5, stepId: 'r2:5' }));
        await store.saveCheckpoints(wide);
        // Overwrites the row at the same (runId, seq).
        await store.saveCheckpoints([
          checkpoint({ seq: 7, stepId: 'r1:7', output: { n: 7 } }),
          checkpoint({ seq: 599, stepId: 'r1:599', status: 'failed', error: { message: 'x' } }),
        ]);
        expect(await store.listCheckpoints('r1')).toHaveLength(600);

        const read = await store.getCheckpoints('r1', [599, 7, 0, 7, 1000, 550]);
        expect(read.map((c) => [c.seq, c.status])).toEqual([
          [0, 'pending'],
          [7, 'completed'],
          [550, 'pending'],
          [599, 'failed'],
        ]);
        expect(read[1]?.output).toEqual({ n: 7 });
        expect(read[3]?.error).toEqual({ message: 'x' });
        const all = await store.getCheckpoints(
          'r1',
          Array.from({ length: 600 }, (_, i) => i),
        );
        expect(all.map((c) => c.seq)).toEqual(Array.from({ length: 600 }, (_, i) => i));
        // Another run's row at a seq it shares is not this run's.
        expect((await store.getCheckpoints('r2', [5, 7])).map((c) => c.stepId)).toEqual(['r2:5']);
      },
      30_000,
    );

    t(
      'saveCheckpointsIfPending settles a batch wider than one statement',
      async () => {
        if (!store.saveCheckpointsIfPending) return;
        await store.createRun(run());
        for (let seq = 0; seq < 600; seq += 1) {
          await store.saveCheckpoint(
            checkpoint({ seq, stepId: `r1:${seq}`, status: 'pending', output: undefined }),
          );
        }
        await store.saveCheckpoint(
          checkpoint({ seq: 300, stepId: 'r1:300', output: { early: true } }),
        );
        const wrote = await store.saveCheckpointsIfPending(
          Array.from({ length: 600 }, (_, seq) =>
            checkpoint({ seq, stepId: `r1:${seq}`, output: { n: seq } }),
          ),
        );
        expect(wrote.filter((w) => !w)).toHaveLength(1);
        expect(wrote[300]).toBe(false);
        const rows = await store.listCheckpoints('r1');
        expect(rows.every((c) => c.status === 'completed')).toBe(true);
        expect(rows[300]?.output).toEqual({ early: true });
        expect(rows[599]?.output).toEqual({ n: 599 });
      },
      30_000,
    );

    t('keeps millisecond precision on every run and checkpoint timestamp', async () => {
      const ms = (iso: string) => new Date(iso);
      await store.createRun(
        run({
          createdAt: ms('2026-06-11T10:00:00.123Z'),
          updatedAt: ms('2026-06-11T10:00:00.456Z'),
          wakeAt: Date.parse('2026-06-11T10:05:00.789Z'),
          lockedUntil: Date.parse('2026-06-11T10:01:00.007Z'),
        }),
      );
      await store.updateRun('r1', { wakeRequestedAt: Date.parse('2026-06-11T10:00:30.999Z') });
      const loaded = await store.getRun('r1');
      expect(loaded?.createdAt.getTime()).toBe(Date.parse('2026-06-11T10:00:00.123Z'));
      expect(loaded?.wakeAt).toBe(Date.parse('2026-06-11T10:05:00.789Z'));
      expect(loaded?.lockedUntil).toBe(Date.parse('2026-06-11T10:01:00.007Z'));
      expect(loaded?.wakeRequestedAt).toBe(Date.parse('2026-06-11T10:00:30.999Z'));
      // A store may stamp updatedAt itself, but whatever it holds keeps its milliseconds.
      expect(loaded?.updatedAt).toBeInstanceOf(Date);

      await store.saveCheckpoint(
        checkpoint({
          enqueuedAt: ms('2026-06-11T10:00:01.001Z'),
          startedAt: ms('2026-06-11T10:00:01.502Z'),
          finishedAt: ms('2026-06-11T10:00:02.003Z'),
          wakeAt: Date.parse('2026-06-11T10:09:00.044Z'),
        }),
      );
      const cp = await store.getCheckpoint('r1', 0);
      expect(cp?.enqueuedAt.getTime()).toBe(Date.parse('2026-06-11T10:00:01.001Z'));
      expect(cp?.startedAt.getTime()).toBe(Date.parse('2026-06-11T10:00:01.502Z'));
      expect(cp?.finishedAt.getTime()).toBe(Date.parse('2026-06-11T10:00:02.003Z'));
      expect(cp?.wakeAt).toBe(Date.parse('2026-06-11T10:09:00.044Z'));
    });

    t(
      'listBufferedSignalTokens lists distinct prefixed tokens with a buffered signal (when implemented)',
      async () => {
        if (!store.listBufferedSignalTokens) return;
        await store.bufferSignal('entity:a:1', { op: 'x' });
        await store.bufferSignal('entity:a:1', { op: 'y' });
        await store.bufferSignal('entity:b:2', { op: 'z' });
        await store.bufferSignal('other', 1);
        expect([...(await store.listBufferedSignalTokens('entity:', 10))].sort()).toEqual([
          'entity:a:1',
          'entity:b:2',
        ]);
        expect(await store.listBufferedSignalTokens('entity:', 1)).toHaveLength(1);
        // Listing consumes nothing; a drained token drops out.
        await store.takeBufferedSignal('entity:b:2');
        expect(await store.listBufferedSignalTokens('entity:', 10)).toEqual(['entity:a:1']);
        // `%` / `_` in the prefix are literal.
        expect(await store.listBufferedSignalTokens('entity_', 10)).toEqual([]);
      },
    );

    t(
      'saveCheckpointsIfPending writes a wide batch',
      async () => {
        if (!store.saveCheckpointsIfPending) return;
        await store.createRun(run());
        const n = 600;
        const rows = Array.from({ length: n }, (_, seq) =>
          checkpoint({ seq, stepId: `r1:${seq}`, status: 'pending', output: undefined }),
        );
        for (const row of rows) await store.saveCheckpoint(row);
        const wrote = await store.saveCheckpointsIfPending(
          rows.map((row) => ({ ...row, status: 'completed' as const, output: { seq: row.seq } })),
        );
        expect(wrote).toHaveLength(n);
        expect(wrote.every((w) => w === true)).toBe(true);
        expect(await store.countCheckpoints?.('r1', 0, n - 1, ['completed'])).toBe(n);
        expect((await store.getCheckpoint('r1', n - 1))?.output).toEqual({ seq: n - 1 });
        // ~1,200 sequential round-trips: a networked store on a loaded runner needs more than 5s.
      },
      30_000,
    );

    t('deleteRuns removes every listed run and its rows, and nothing else', async () => {
      expect(store.deleteRuns).toBeDefined();
      if (!store.deleteRuns) return;
      await store.deleteRuns([]);
      for (const id of ['a', 'b', 'keep']) {
        await store.createRun(run({ id, searchAttributes: { tier: 'pro' } }));
        await store.saveCheckpoint(checkpoint({ runId: id, stepId: `${id}:0` }));
        await store.putSignalWaiter({ token: `tok-${id}`, runId: id, seq: 1 });
      }
      await store.deleteRuns(['a', 'b', 'missing', 'a']);
      expect(await store.getRun('a')).toBeNull();
      expect(await store.getRun('b')).toBeNull();
      expect(await store.listCheckpoints('a')).toEqual([]);
      expect(await store.listSignalWaiters('tok-a')).toEqual([]);
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['keep']);
      expect((await store.getRun('keep'))?.id).toBe('keep');
      expect(await store.listCheckpoints('keep')).toHaveLength(1);
      expect(await store.listSignalWaiters('tok-keep')).toHaveLength(1);
    });

    t('runFacets counts the matching runs by (status, origin)', async () => {
      expect(store.runFacets).toBeDefined();
      if (!store.runFacets) return;
      const seedRun = (id: string, status: RunStatus, origin?: string, workflow = 'checkout') =>
        store.createRun(run({ id, status, workflow, ...(origin !== undefined ? { origin } : {}) }));
      await seedRun('f1', 'completed', 'api');
      await seedRun('f2', 'completed', 'api');
      await seedRun('f3', 'failed', 'api');
      await seedRun('f4', 'completed');
      await seedRun('f5', 'completed', '  ');
      await seedRun('f6', 'running', 'cron', 'other');
      const sort = (rows: { status: string; origin: string | null; count: number }[]) =>
        [...rows].sort((a, b) =>
          `${a.status}|${a.origin}`.localeCompare(`${b.status}|${b.origin}`),
        );
      expect(sort(await store.runFacets({}))).toEqual(
        sort([
          { status: 'completed', origin: 'api', count: 2 },
          { status: 'failed', origin: 'api', count: 1 },
          // An absent and a blank origin are the same unattributed bucket.
          { status: 'completed', origin: null, count: 2 },
          { status: 'running', origin: 'cron', count: 1 },
        ]),
      );
      expect(sort(await store.runFacets({ workflow: 'other' }))).toEqual([
        { status: 'running', origin: 'cron', count: 1 },
      ]);
      expect(await store.runFacets({ workflow: 'none' })).toEqual([]);
    });

    t('pruneBufferedEvents deletes the oldest expired events, capped at limit', async () => {
      expect(store.pruneBufferedEvents).toBeDefined();
      if (!store.pruneBufferedEvents) return;
      for (const [id, name, publishedAt] of [
        ['e1', 'a', 100],
        ['e2', 'b', 200],
        ['e3', 'a', 300],
        ['e4', 'b', 1_000],
      ] as const) {
        await store.bufferEvent({ id, name, payload: { id }, publishedAt });
      }
      expect(await store.pruneBufferedEvents(500, 2)).toBe(2);
      expect((await store.listBufferedEvents('a', 10)).map((e) => e.id)).toEqual(['e3']);
      expect((await store.listBufferedEvents('b', 10)).map((e) => e.id)).toEqual(['e4']);
      expect(await store.pruneBufferedEvents(500, 10)).toBe(1);
      expect(await store.pruneBufferedEvents(500, 10)).toBe(0);
      expect((await store.listBufferedEvents('b', 10)).map((e) => e.id)).toEqual(['e4']);
    });

    t('withScope fences run reads to one namespace (when the store scopes)', async () => {
      const scopeable = store as StateStore & {
        withScope?: (scope: { namespace?: string | undefined }) => StateStore;
      };
      if (typeof scopeable.withScope !== 'function') return;
      await store.createRun(run({ id: 'mine', namespace: 'acme', status: 'pending' }));
      await store.createRun(run({ id: 'theirs', namespace: 'globex', status: 'pending' }));
      const acme = scopeable.withScope({ namespace: 'acme' });
      expect((await acme.getRun('mine'))?.id).toBe('mine');
      expect(await acme.getRun('theirs')).toBeNull();
      expect((await acme.listRuns({})).map((r) => r.id)).toEqual(['mine']);
      expect((await acme.listPendingRuns(10)).map((r) => r.id)).toEqual(['mine']);
      expect(await acme.countRuns?.({})).toBe(1);
      // Writes are not fenced, and the operator view still sees both.
      await acme.updateRun('theirs', { status: 'running' });
      expect((await store.getRun('theirs'))?.status).toBe('running');
      expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['mine', 'theirs']);
      const operator = scopeable.withScope({ namespace: undefined });
      expect(await operator.listRuns({})).toHaveLength(2);
    });

    registerCheckpointAggregationCases(t, () => store, run);

    t(
      'upserts checkpoints, reads them by (runId, seq), and lists them ordered by seq',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(checkpoint());
        await store.saveCheckpoint(
          checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
        );
        // Re-save seq 0 with a new output — upsert, not a duplicate row.
        await store.saveCheckpoint(checkpoint({ output: { ok: true, again: true } }));

        expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true, again: true });
        expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
        const list = await store.listCheckpoints('r1');
        expect(list.map((c) => c.seq)).toEqual([0, 1]);
      },
    );

    t(
      'getLatestCheckpointByName returns the highest-seq match (and undefined for none)',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(
          checkpoint({ seq: 0, name: 'event:progress', output: { pct: 10 } }),
        );
        await store.saveCheckpoint(checkpoint({ seq: 1, name: 'charge', output: { id: 'c1' } }));
        await store.saveCheckpoint(
          checkpoint({ seq: 2, name: 'event:progress', output: { pct: 50 } }),
        );
        await store.saveCheckpoint(
          checkpoint({ seq: 3, name: 'event:progress', output: { pct: 90 } }),
        );

        // Optional on the interface (the engine has a fallback), but a conformant store MUST provide
        // it — assert presence, then exercise the fast path.
        const getLatestCheckpointByName = store.getLatestCheckpointByName;
        expect(getLatestCheckpointByName).toBeDefined();
        if (!getLatestCheckpointByName) return;

        const latest = await getLatestCheckpointByName.call(store, 'r1', 'event:progress');
        expect(latest?.seq).toBe(3);
        expect(latest?.output).toEqual({ pct: 90 });
        expect(await getLatestCheckpointByName.call(store, 'r1', 'event:missing')).toBeUndefined();
      },
    );

    t(
      'listCheckpointsByNamePrefix returns prefix matches ordered by seq (empty => none)',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(checkpoint({ seq: 0, name: 'reserve' }));
        await store.saveCheckpoint(checkpoint({ seq: 1, name: 'spawn:0', output: 'child-a' }));
        await store.saveCheckpoint(checkpoint({ seq: 2, name: 'signal:child:c2' }));
        await store.saveCheckpoint(checkpoint({ seq: 3, name: 'event:progress' }));
        await store.saveCheckpoint(checkpoint({ seq: 4, name: 'spawn:1', output: 'child-b' }));

        // Optional on the interface (the engine has a fallback), but a conformant store MUST provide
        // it — assert presence, then exercise the fast path.
        const listCheckpointsByNamePrefix = store.listCheckpointsByNamePrefix;
        expect(listCheckpointsByNamePrefix).toBeDefined();
        if (!listCheckpointsByNamePrefix) return;

        const matches = await listCheckpointsByNamePrefix.call(store, 'r1', [
          'signal:child:',
          'spawn:',
        ]);
        expect(matches.map((c) => c.name)).toEqual(['spawn:0', 'signal:child:c2', 'spawn:1']);
        expect(await listCheckpointsByNamePrefix.call(store, 'r1', [])).toEqual([]);
      },
    );

    t('round-trips checkpoint events and reads back a missing checkpoint as null', async () => {
      await store.createRun(run());
      await store.saveCheckpoint(
        checkpoint({
          events: [{ at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' }],
        }),
      );
      expect((await store.getCheckpoint('r1', 0))?.events).toEqual([
        { at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' },
      ]);
      expect(await store.getCheckpoint('r1', 99)).toBeNull();
    });

    // ---- recovery / dispatch / timer scans --------------------------------------------------

    t('lists incomplete runs, pending runs (FIFO), and due timers', async () => {
      await store.createRun(run({ id: 'running1', status: 'running' }));
      await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
      await store.createRun(run({ id: 'done1', status: 'completed' }));
      await store.createRun(
        run({ id: 'pending2', status: 'pending', createdAt: new Date('2026-06-11T00:00:02.000Z') }),
      );
      await store.createRun(
        run({ id: 'pending1', status: 'pending', createdAt: new Date('2026-06-11T00:00:01.000Z') }),
      );

      expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
      // FIFO by createdAt.
      expect((await store.listPendingRuns(10)).map((r) => r.id)).toEqual(['pending1', 'pending2']);
      expect((await store.listPendingRuns(1)).map((r) => r.id)).toEqual(['pending1']);
      expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
      expect(await store.listDueTimers(1_000)).toHaveLength(0);
    });

    t('scopes recovery/dispatch/timer scans by namespace (and no-arg spans all)', async () => {
      await store.createRun(run({ id: 'r-alpha', status: 'running', namespace: 'alpha' }));
      await store.createRun(run({ id: 'r-beta', status: 'running', namespace: 'beta' }));
      await store.createRun(run({ id: 'p-alpha', status: 'pending', namespace: 'alpha' }));
      await store.createRun(run({ id: 'p-beta', status: 'pending', namespace: 'beta' }));
      await store.createRun(
        run({ id: 't-alpha', status: 'suspended', wakeAt: 5_000, namespace: 'alpha' }),
      );
      await store.createRun(
        run({ id: 't-beta', status: 'suspended', wakeAt: 5_000, namespace: 'beta' }),
      );

      // Filtered by namespace — a worker only sees its own pool's runs.
      expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r-alpha']);
      expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['p-alpha']);
      expect((await store.listDueTimers(10_000, 'alpha')).map((r) => r.id)).toEqual(['t-alpha']);

      // No-arg spans every namespace (back-compat with single-pool callers).
      expect((await store.listIncompleteRuns()).map((r) => r.id).sort()).toEqual([
        'r-alpha',
        'r-beta',
      ]);
      expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual([
        'p-alpha',
        'p-beta',
      ]);
      expect((await store.listDueTimers(10_000)).map((r) => r.id).sort()).toEqual([
        't-alpha',
        't-beta',
      ]);

      // A run created without a namespace normalizes to 'default' (the column DEFAULT).
      await store.createRun(run({ id: 'legacy', status: 'running' }));
      expect((await store.getRun('legacy'))?.namespace).toBe('default');
      expect((await store.listIncompleteRuns('default')).map((r) => r.id)).toEqual(['legacy']);
    });

    // ---- lease / lock -----------------------------------------------------------------------

    t('tryLockRun is atomic and respects lease expiry', async () => {
      await store.createRun(run({ id: 'r1' }));
      expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
      // B can't take it while A's lease is live.
      expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
      // Once A's lease (2_000) has passed, B reclaims it.
      expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
      // Release lets anyone re-acquire immediately.
      await store.releaseRunLock('r1');
      expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
    });

    t(
      'listOrphanedRuns returns only running runs with a free/expired lease (when implemented)',
      async () => {
        if (!store.listOrphanedRuns) return; // optional — the engine falls back to listIncompleteRuns
        await store.createRun(run({ id: 'free', status: 'running' }));
        await store.createRun(run({ id: 'leased', status: 'running' }));
        await store.createRun(run({ id: 'expired', status: 'running' }));
        await store.createRun(run({ id: 'idle', status: 'suspended' }));
        await store.tryLockRun('leased', 'A', 9_000, 1_000);
        await store.tryLockRun('expired', 'A', 2_000, 1_000);
        const orphans = await store.listOrphanedRuns(5_000, 10);
        expect(orphans.map((r) => r.id).sort()).toEqual(['expired', 'free']);
        // The limit caps the batch.
        expect((await store.listOrphanedRuns(5_000, 1)).length).toBe(1);
      },
    );

    t(
      'listOrphanedRuns with an owner also returns the runs still leased to that owner',
      async () => {
        if (!store.listOrphanedRuns) return;
        await store.createRun(run({ id: 'free', status: 'running' }));
        await store.createRun(run({ id: 'mine', status: 'running' }));
        await store.createRun(run({ id: 'theirs', status: 'running' }));
        await store.createRun(run({ id: 'mine-idle', status: 'suspended' }));
        await store.tryLockRun('mine', 'A', 9_000, 1_000);
        await store.tryLockRun('theirs', 'B', 9_000, 1_000);
        await store.tryLockRun('mine-idle', 'A', 9_000, 1_000);
        const withOwner = await store.listOrphanedRuns(5_000, 10, undefined, 'A');
        // A store that predates the `owner` parameter ignores it (expiry-only): still conformant.
        const ids = withOwner.map((r) => r.id).sort();
        expect([['free'], ['free', 'mine']]).toContainEqual(ids);
        expect((await store.listOrphanedRuns(5_000, 10)).map((r) => r.id)).toEqual(['free']);
      },
    );

    t('listDueTimers returns the most overdue first, capped at limit', async () => {
      for (const [id, wakeAt] of [
        ['late', 3_000],
        ['earliest', 1_000],
        ['middle', 2_000],
        ['future', 9_000],
      ] as const) {
        await store.createRun(run({ id, status: 'suspended', wakeAt }));
      }

      expect((await store.listDueTimers(5_000)).map((r) => r.id)).toEqual([
        'earliest',
        'middle',
        'late',
      ]);
      expect((await store.listDueTimers(5_000, undefined, 2)).map((r) => r.id)).toEqual([
        'earliest',
        'middle',
      ]);
    });

    t('listDueTimers honors the optional limit, oldest deadline first (when applied)', async () => {
      await store.createRun(run({ id: 'later', status: 'suspended', wakeAt: 4_000 }));
      await store.createRun(run({ id: 'sooner', status: 'suspended', wakeAt: 2_000 }));
      const capped = await store.listDueTimers(9_000, undefined, 1);
      // A store may ignore the cap (back-compat); when it applies it, oldest deadline wins.
      if (capped.length === 1) expect(capped[0]?.id).toBe('sooner');
      expect((await store.listDueTimers(9_000, undefined, 5)).length).toBe(2);
    });

    t(
      'listSignalWaitersByRunIds returns only the given runs’ waiters (when implemented)',
      async () => {
        if (!store.listSignalWaitersByRunIds) return;
        await store.createRun(run({ id: 'w1' }));
        await store.createRun(run({ id: 'w2' }));
        await store.putSignalWaiter({ token: 'a', runId: 'w1', seq: 0 });
        await store.putSignalWaiter({ token: 'b', runId: 'w2', seq: 0 });
        await store.putSignalWaiter({ token: 'c', runId: 'w1', seq: 1 });
        const waiters = await store.listSignalWaitersByRunIds(['w1']);
        expect(waiters.map((w) => w.token).sort()).toEqual(['a', 'c']);
        expect(await store.listSignalWaitersByRunIds([])).toEqual([]);
      },
    );

    t('listSignalWaitersByRunIds round-trips every field of the given runs’ waiters', async () => {
      if (!store.listSignalWaitersByRunIds) return;
      await store.putSignalWaiter({
        token: 'child:a.all.0.0',
        runId: 'a',
        seq: 0,
        parallelGroup: 'all:0',
      });
      await store.putSignalWaiter({ token: 'approve-a', runId: 'a', seq: 1 });
      await store.putSignalWaiter({ token: 'approve-b', runId: 'b', seq: 0 });
      await store.putSignalWaiter({ token: 'approve-c', runId: 'c', seq: 0 });

      const tokens = async (ids: string[]) =>
        ((await store.listSignalWaitersByRunIds?.(ids)) ?? []).map((w) => w.token).sort();
      expect(await tokens(['a', 'b'])).toEqual(['approve-a', 'approve-b', 'child:a.all.0.0']);
      expect(await tokens(['missing'])).toEqual([]);
      const fan = (await store.listSignalWaitersByRunIds(['a'])).find((w) => w.seq === 0);
      expect(fan).toEqual({ token: 'child:a.all.0.0', runId: 'a', seq: 0, parallelGroup: 'all:0' });
    });

    t('hasSignalWaiter answers by run and exact token prefix (when implemented)', async () => {
      if (!store.hasSignalWaiter) return;
      const has = (runId: string, prefix: string) => store.hasSignalWaiter?.(runId, prefix);
      await store.putSignalWaiter({
        token: 'child:p_1.all.3.0',
        runId: 'p_1',
        seq: 3,
        parallelGroup: 'all:3',
      });
      // A grandchild's waiter shares the token prefix but belongs to another run.
      await store.putSignalWaiter({
        token: 'child:p_1.all.4.0.all.0.0',
        runId: 'p_1.all.4.0',
        seq: 0,
      });
      // Matches `child:p_1.all.3.%` as a LIKE pattern (`_` is a wildcard there) but not as a prefix.
      await store.putSignalWaiter({ token: 'child:pX1.all.3.0', runId: 'p_1', seq: 9 });
      // Matches `child:P_1.all.3.%` under a case-insensitive LIKE, but not as a prefix.
      await store.putSignalWaiter({ token: 'child:P_1.all.5.0', runId: 'p_1', seq: 10 });

      expect(await has('p_1', 'child:p_1.all.3.')).toBe(true);
      expect(await has('p_1', 'child:p_1.all.4.')).toBe(false);
      expect(await has('other', 'child:p_1.all.3.')).toBe(false);
      // `_` and `%` are literal, not wildcards, and the match is case-sensitive.
      expect(await has('p_1', 'child:p%.all.3.')).toBe(false);
      expect(await has('p_1', 'child:p_1.all.5.')).toBe(false);
      expect(await has('p_1', 'CHILD:p_1.all.3.')).toBe(false);

      await store.takeSignalWaiter('child:p_1.all.3.0');
      expect(await has('p_1', 'child:p_1.all.3.')).toBe(false);
    });

    t(
      'registerChildWaits writes every waiter and placeholder, and upserts on repeat (when implemented)',
      async () => {
        if (!store.registerChildWaits) return;
        await store.createRun(run({ id: 'p' }));
        const entry = (i: number, status: StepCheckpoint['status']) => ({
          waiter: { token: `child:p.all.0.${i}`, runId: 'p', seq: i, parallelGroup: 'all:0' },
          checkpoint: checkpoint({
            runId: 'p',
            seq: i,
            stepId: `p:${i}`,
            name: `signal:child:p.all.0.${i}`,
            kind: 'signal',
            status,
            output: undefined,
            parallelGroup: 'all:0',
          }),
        });
        // Wider than one statement on stores that split the batch.
        const entries = Array.from({ length: 250 }, (_, i) => entry(i, 'running'));
        await store.registerChildWaits(entries);

        const waiters = await store.listSignalWaiters('child:p.all.0.');
        expect(waiters).toHaveLength(250);
        expect(waiters.find((w) => w.token === 'child:p.all.0.7')).toEqual(entries[7]?.waiter);
        const cps = await store.listCheckpoints('p');
        expect(cps).toHaveLength(250);
        expect(cps[7]).toMatchObject({ name: 'signal:child:p.all.0.7', status: 'running' });
        expect(cps[7]?.parallelGroup).toBe('all:0');

        await store.registerChildWaits([entry(7, 'completed')]);
        expect((await store.getCheckpoint('p', 7))?.status).toBe('completed');
        expect(await store.listCheckpoints('p')).toHaveLength(250);
        await expect(store.registerChildWaits([])).resolves.toBeUndefined();
      },
    );

    t(
      'compactCheckpoints replaces a seq range with one checkpoint, atomically (when implemented)',
      async () => {
        if (!store.compactCheckpoints) return;
        await store.createRun(run({ id: 'r' }));
        await store.createRun(run({ id: 'other' }));
        for (let seq = 0; seq < 10; seq += 1) {
          await store.saveCheckpoint(checkpoint({ runId: 'r', seq, stepId: `r:${seq}` }));
        }
        await store.saveCheckpoint(checkpoint({ runId: 'other', seq: 3, stepId: 'other:3' }));
        const into = checkpoint({
          runId: 'r',
          seq: 2,
          stepId: 'r:2',
          name: 'fan:r.all.2.',
          kind: 'signal',
          output: { from: 0, values: [{ n: 1 }, 'two', null] },
          parallelGroup: 'all:2',
        });

        await store.compactCheckpoints('r', 2, 7, into);

        const left = await store.listCheckpoints('r');
        expect(left.map((cp) => cp.seq)).toEqual([0, 1, 2, 8, 9]);
        expect(left[2]).toMatchObject({ name: 'fan:r.all.2.', parallelGroup: 'all:2' });
        expect(left[2]?.output).toEqual({ from: 0, values: [{ n: 1 }, 'two', null] });
        expect(await store.listCheckpoints('other')).toHaveLength(1);
      },
    );

    t('tag values containing LIKE metacharacters match exactly (no pattern widening)', async () => {
      await store.createRun(run({ id: 'meta', tags: ['50%_off'] }));
      await store.createRun(run({ id: 'decoy', tags: ['50x_off'] }));
      // `%`/`_` in a tag VALUE are literals, not wildcards: `50%_off` must not match `50x_off`.
      expect((await store.listRuns({ tag: '50%_off' })).map((r) => r.id)).toEqual(['meta']);
      expect((await store.listRuns({ tags: ['50%_off'] })).map((r) => r.id)).toEqual(['meta']);
    });

    t('listRuns pushes createdBefore/createdAfter/wakeBefore down as predicates', async () => {
      await store.createRun(run({ id: 'old', createdAt: new Date(1_000), updatedAt: at }));
      await store.createRun(run({ id: 'new', createdAt: new Date(9_000), updatedAt: at }));
      await store.createRun(
        run({ id: 'due', status: 'blocked', wakeAt: 2_000, createdAt: new Date(1_000) }),
      );
      await store.createRun(
        run({ id: 'not-due', status: 'blocked', wakeAt: 9_000, createdAt: new Date(1_000) }),
      );
      expect((await store.listRuns({ createdBefore: 5_000 })).map((r) => r.id).sort()).toEqual([
        'due',
        'not-due',
        'old',
      ]);
      expect((await store.listRuns({ createdAfter: 5_000 })).map((r) => r.id)).toEqual(['new']);
      expect(
        (await store.listRuns({ statuses: ['blocked'], wakeBefore: 5_000 })).map((r) => r.id),
      ).toEqual(['due']);
    });

    t(
      'releaseRunLock with an owner only releases that owner’s lease (zombie fencing)',
      async () => {
        await store.createRun(run({ id: 'r1' }));
        expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
        // A's lease expires; B takes over.
        expect(await store.tryLockRun('r1', 'B', 9_000, 2_500)).toBe(true);
        // Zombie A's owner-scoped release must NOT wipe B's live lease…
        await store.releaseRunLock('r1', 'A');
        expect(await store.tryLockRun('r1', 'C', 9_500, 3_000)).toBe(false);
        // …while B's own owner-scoped release does free it.
        await store.releaseRunLock('r1', 'B');
        expect(await store.tryLockRun('r1', 'C', 9_500, 3_100)).toBe(true);
      },
    );

    t('renewRunLock only succeeds for the current owner', async () => {
      await store.createRun(run({ id: 'r1' }));
      expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
      // The holder heartbeats and keeps the lease.
      expect(await store.renewRunLock('r1', 'A', 5_000)).toBe(true);
      // A different instance can't renew a lease it doesn't hold.
      expect(await store.renewRunLock('r1', 'B', 9_000)).toBe(false);
      // And the renewed lease is honored: B still can't steal it before it expires.
      expect(await store.tryLockRun('r1', 'B', 6_000, 4_000)).toBe(false);
    });

    // ---- list filters: status / statuses / tag ----------------------------------------------

    t('filters listRuns by workflow and by status', async () => {
      await store.createRun(run({ id: 'a', workflow: 'checkout', status: 'running' }));
      await store.createRun(run({ id: 'b', workflow: 'refund', status: 'running' }));
      await store.createRun(run({ id: 'c', workflow: 'checkout', status: 'completed' }));

      expect((await store.listRuns({ workflow: 'checkout' })).map((r) => r.id).sort()).toEqual([
        'a',
        'c',
      ]);
      expect((await store.listRuns({ status: 'running' })).map((r) => r.id).sort()).toEqual([
        'a',
        'b',
      ]);
      expect(
        (await store.listRuns({ workflow: 'checkout', status: 'running' })).map((r) => r.id),
      ).toEqual(['a']);
    });

    t('filters listRuns by a status set (status IN ...) for singleton admission', async () => {
      await store.createRun(run({ id: 'a', status: 'running' }));
      await store.createRun(run({ id: 'b', status: 'suspended' }));
      await store.createRun(run({ id: 'c', status: 'completed' }));
      await store.createRun(run({ id: 'd', status: 'pending' }));

      expect(
        (await store.listRuns({ statuses: ['running', 'suspended'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
      // Single + set are ANDed (the narrower set wins).
      expect(
        (await store.listRuns({ status: 'running', statuses: ['running', 'suspended'] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
      // Empty set matches nothing.
      expect(await store.listRuns({ statuses: [] })).toHaveLength(0);
    });

    t('filters listRuns by an exact tag (no substring match)', async () => {
      if (!supportsTagFilter) return; // Prisma + SQLite: array_contains is unsupported there (see flag doc)
      await store.createRun(run({ id: 'a', tags: ['etl', 'critical'] }));
      await store.createRun(run({ id: 'b', tags: ['etl-foo'] }));
      await store.createRun(run({ id: 'c' })); // no tags

      expect((await store.getRun('a'))?.tags).toEqual(['etl', 'critical']);
      expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['a']);
      expect((await store.listRuns({ tag: 'etl-foo' })).map((r) => r.id)).toEqual(['b']);
      expect(await store.listRuns({ tag: 'nope' })).toHaveLength(0);
    });

    t('countRuns counts the same set listRuns returns, without the paging', async () => {
      expect(typeof store.countRuns).toBe('function');
      await store.createRun(run({ id: 'n1', status: 'running', namespace: 'a', tags: ['q'] }));
      await store.createRun(run({ id: 'n2', status: 'pending', namespace: 'a' }));
      await store.createRun(run({ id: 'n3', status: 'completed', namespace: 'a', tags: ['q'] }));
      await store.createRun(run({ id: 'n4', status: 'running', namespace: 'b', tags: ['q'] }));

      expect(await store.countRuns?.({})).toBe(4);
      expect(await store.countRuns?.({ namespace: 'a' })).toBe(3);
      expect(await store.countRuns?.({ namespace: 'a', statuses: ['pending', 'running'] })).toBe(2);
      if (supportsTagFilter) {
        expect(await store.countRuns?.({ tag: 'q', statuses: ['running', 'pending'] })).toBe(2);
      }
    });

    t(
      'engine rejects a start over its concurrency quota and frees the slot once a run settles',
      async () => {
        if (!supportsTagFilter) return;
        const engine = new WorkflowEngine({ store });
        engine.register('q-wait', '1', async (ctx) => ctx.waitForSignal('never'));
        const quota = { key: 'tenant:a', limit: 1 };

        await engine.start('q-wait', {}, 'q1', { concurrency: quota });
        await expect(engine.start('q-wait', {}, 'q2', { concurrency: quota })).rejects.toThrow(
          /concurrency limit/,
        );
        expect(await store.getRun('q2')).toBeNull(); // nothing was created
        await engine.start('q-wait', {}, 'q3', { concurrency: { ...quota, key: 'tenant:b' } });

        await engine.cancel('q1');
        await engine.start('q-wait', {}, 'q4', { concurrency: quota });
        expect(await store.getRun('q4')).not.toBeNull();
        await engine.drain();
      },
    );

    // ---- persisted schedules ----------------------------------------------------------------

    const NOW = Date.parse('2026-06-20T00:00:00.000Z');
    const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
      id: 's1',
      namespace: 'default',
      workflow: 'digest',
      paused: false,
      nextFireAt: NOW + 60_000,
      tags: ['tenant:a'],
      spec: { v: 1, cron: '0 9 * * *', input: { userId: 'u1', deep: [1, { x: true }] } },
      state: { window: NOW + 60_000 },
      createdAt: at,
      updatedAt: at,
      ...over,
    });

    t('saves, reads back, replaces and deletes a schedule', async () => {
      expect(typeof store.saveSchedule).toBe('function');
      await store.saveSchedule?.(schedule());
      const loaded = await store.getSchedule?.('s1');
      expect(loaded).toMatchObject({
        id: 's1',
        namespace: 'default',
        workflow: 'digest',
        paused: false,
        nextFireAt: NOW + 60_000,
        tags: ['tenant:a'],
        spec: { v: 1, cron: '0 9 * * *', input: { userId: 'u1', deep: [1, { x: true }] } },
        state: { window: NOW + 60_000 },
      });
      expect(loaded?.createdAt.getTime()).toBe(at.getTime());

      // saveSchedule is an upsert: a second save replaces the row.
      await store.saveSchedule?.(
        schedule({ workflow: 'digest2', nextFireAt: null, tags: undefined }),
      );
      const replaced = await store.getSchedule?.('s1');
      expect(replaced?.workflow).toBe('digest2');
      expect(replaced?.nextFireAt).toBeNull();
      expect(replaced?.tags ?? []).toEqual([]);

      expect(await store.getSchedule?.('nope')).toBeNull();
      expect(await store.deleteSchedule?.('s1')).toBe(true);
      expect(await store.deleteSchedule?.('s1')).toBe(false);
      expect(await store.getSchedule?.('s1')).toBeNull();
    });

    t('updateSchedule patches, and compare-and-sets on nextFireAt', async () => {
      await store.saveSchedule?.(schedule());
      expect(await store.updateSchedule?.('s1', { paused: true })).toBe(true);
      expect((await store.getSchedule?.('s1'))?.paused).toBe(true);

      const next = { nextFireAt: NOW + 120_000, state: { window: NOW + 120_000, fires: 1 } };
      expect(await store.updateSchedule?.('s1', next, NOW + 60_000)).toBe(true);
      expect(await store.updateSchedule?.('s1', next, NOW + 60_000)).toBe(false);
      const after = await store.getSchedule?.('s1');
      expect(after?.nextFireAt).toBe(NOW + 120_000);
      expect(after?.state).toEqual({ window: NOW + 120_000, fires: 1 });

      await store.updateSchedule?.('s1', { nextFireAt: null });
      expect(await store.updateSchedule?.('s1', { nextFireAt: NOW }, NOW + 1)).toBe(false);
      expect(await store.updateSchedule?.('s1', { nextFireAt: NOW }, null)).toBe(true);
      expect(await store.updateSchedule?.('ghost', { paused: true })).toBe(false);
    });

    t('lists schedules by namespace/workflow/tag/paused and answers "due by"', async () => {
      await store.saveSchedule?.(schedule({ id: 'a', nextFireAt: NOW - 10 }));
      await store.saveSchedule?.(schedule({ id: 'b', nextFireAt: NOW - 20, namespace: 'x' }));
      await store.saveSchedule?.(schedule({ id: 'c', nextFireAt: NOW - 30, paused: true }));
      await store.saveSchedule?.(schedule({ id: 'd', nextFireAt: NOW + 10, workflow: 'other' }));
      await store.saveSchedule?.(schedule({ id: 'e', nextFireAt: null, tags: ['tenant:b'] }));
      const ids = async (q: ScheduleQuery) =>
        ((await store.listSchedules?.(q)) ?? []).map((r) => r.id);

      expect(await ids({})).toEqual(['c', 'b', 'a', 'd', 'e']);
      expect(await ids({ dueBy: NOW })).toEqual(['b', 'a']);
      expect(await ids({ dueBy: NOW, namespace: 'default' })).toEqual(['a']);
      expect(await ids({ dueBy: NOW, limit: 1 })).toEqual(['b']);
      expect(await ids({ workflow: 'other' })).toEqual(['d']);
      expect(await ids({ paused: true })).toEqual(['c']);
      if (supportsTagFilter) expect(await ids({ tag: 'tenant:b' })).toEqual(['e']);
      expect(await ids({ limit: 2, offset: 1 })).toEqual(['b', 'a']);
    });

    t('orders listRuns newest-first and paginates with 1-based page/size', async () => {
      await store.createRun(run({ id: 'old', createdAt: new Date('2026-06-11T00:00:00.000Z') }));
      await store.createRun(run({ id: 'mid', createdAt: new Date('2026-06-11T00:00:01.000Z') }));
      await store.createRun(run({ id: 'new', createdAt: new Date('2026-06-11T00:00:02.000Z') }));

      // No `size` means no bound — a store must not invent a default page window.
      expect((await store.listRuns({})).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.listRuns({ size: 2 })).map((r) => r.id)).toEqual(['new', 'mid']);
      // `page` is 1-based and defaults to 1: `size: 2` alone and `page: 1, size: 2` are the same page.
      expect((await store.listRuns({ page: 1, size: 2 })).map((r) => r.id)).toEqual(['new', 'mid']);
      expect((await store.listRuns({ page: 2, size: 2 })).map((r) => r.id)).toEqual(['old']);
      expect(await store.listRuns({ page: 3, size: 2 })).toHaveLength(0);
    });

    // ---- search-attribute pushdown (range + equality + the missing-key contract) ------------

    t('round-trips searchAttributes and answers equality + range attribute queries', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { amount: 30, tier: 'free' } }));
      await store.createRun(run({ id: 'b', searchAttributes: { amount: 200, tier: 'pro' } }));
      await store.createRun(run({ id: 'c', searchAttributes: { amount: 500, tier: 'pro' } }));

      expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });

      // Range (numeric).
      expect(
        (await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
      // Two ANDed predicates (string eq + numeric range).
      expect(
        (
          await store.listRuns({
            attributes: [
              { key: 'tier', op: 'eq', value: 'pro' },
              { key: 'amount', op: 'lt', value: 300 },
            ],
          })
        ).map((r) => r.id),
      ).toEqual(['b']);
      // `ne` excludes the matching value AND absent keys (missing-key-never-matches contract).
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'ne', value: 'free' }] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
    });

    t('matches a boolean search attribute by eq/ne', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { vip: true } }));
      await store.createRun(run({ id: 'b', searchAttributes: { vip: false } }));
      await store.createRun(run({ id: 'c', searchAttributes: { other: 1 } })); // no `vip`

      expect(
        (await store.listRuns({ attributes: [{ key: 'vip', op: 'eq', value: true }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
      // ne=true matches the explicit false but NOT the run missing `vip` (missing-key contract).
      expect(
        (await store.listRuns({ attributes: [{ key: 'vip', op: 'ne', value: true }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['b']);
    });

    t('a predicate on an absent key matches nothing (every op)', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { amount: 100 } }));
      for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const) {
        expect(
          await store.listRuns({ attributes: [{ key: 'missing', op, value: 1 }] }),
        ).toHaveLength(0);
      }
      expect(
        await store.listRuns({ attributes: [{ key: 'missing', op: 'in', values: [1] }] }),
      ).toHaveLength(0);
    });

    t('matches an attribute value set with the in operator (OR inside one predicate)', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 30 } }));
      await store.createRun(run({ id: 'b', searchAttributes: { tier: 'pro', amount: 200 } }));
      await store.createRun(
        run({ id: 'c', searchAttributes: { tier: 'enterprise', amount: 500 } }),
      );
      await store.createRun(run({ id: 'd', searchAttributes: { other: 1 } })); // no `tier`

      // Two `eq`s on one key are ANDed (no run has two tiers) — `in` is the set spelling.
      expect(
        (
          await store.listRuns({
            attributes: [{ key: 'tier', op: 'in', values: ['pro', 'enterprise'] }],
          })
        )
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
      // A single value under `in` is just `eq`.
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: ['pro'] }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['b']);
      // Numeric and boolean members compare in their own column.
      expect(
        (await store.listRuns({ attributes: [{ key: 'amount', op: 'in', values: [30, 500] }] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual(['a', 'c']);
      // An empty set matches nothing (mirrors `statuses: []`).
      expect(
        await store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: [] }] }),
      ).toHaveLength(0);
      // Runs missing the key never match, even under `in`.
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: ['free'] }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
    });

    t('filters listRuns by workflow / tag / namespace sets (IN ...)', async () => {
      if (!supportsTagFilter) return; // Prisma + SQLite: array_contains is unsupported there (see flag doc)
      await store.createRun(
        run({ id: 'a', workflow: 'checkout', namespace: 'acme', tags: ['etl', 'nightly'] }),
      );
      await store.createRun(
        run({ id: 'b', workflow: 'refund', namespace: 'acme', tags: ['nightly'] }),
      );
      await store.createRun(
        run({ id: 'c', workflow: 'checkout', namespace: 'globex', tags: ['etl-foo'] }),
      );

      expect((await store.listRuns({ workflows: ['checkout'] })).map((r) => r.id).sort()).toEqual([
        'a',
        'c',
      ]);
      // Tags are a set per run: the set predicate is the union, not the intersection.
      expect((await store.listRuns({ tags: ['etl', 'refund'] })).map((r) => r.id)).toEqual(['a']);
      expect((await store.listRuns({ tags: ['etl', 'nightly'] })).map((r) => r.id).sort()).toEqual([
        'a',
        'b',
      ]);
      expect(
        (await store.listRuns({ namespaces: ['acme', 'globex'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b', 'c']);
      // Single + set are ANDed (the narrower set wins).
      expect((await store.listRuns({ tag: 'nightly', tags: ['etl'] })).map((r) => r.id)).toEqual([
        'a',
      ]);
      // Empty sets match nothing.
      expect(await store.listRuns({ workflows: [] })).toHaveLength(0);
      expect(await store.listRuns({ tags: [] })).toHaveLength(0);
      expect(await store.listRuns({ namespaces: [] })).toHaveLength(0);
    });

    t('enumerates value facets for the column axes (workflow / status / namespace)', async () => {
      if (!store.runValueFacets) return; // optional store method — callers fall back to a scan
      await store.createRun(run({ id: 'a', workflow: 'checkout', status: 'completed' }));
      await store.createRun(run({ id: 'b', workflow: 'checkout', status: 'failed' }));
      await store.createRun(
        run({ id: 'c', workflow: 'refund', status: 'completed', namespace: 'acme' }),
      );

      expect(await store.runValueFacets({ field: 'workflow' }, {})).toEqual([
        { value: 'checkout', count: 2 },
        { value: 'refund', count: 1 },
      ]);
      expect(await store.runValueFacets({ field: 'status' }, {})).toEqual([
        { value: 'completed', count: 2 },
        { value: 'failed', count: 1 },
      ]);
      // The scope narrows the enumeration: only `checkout` runs are counted here.
      expect(await store.runValueFacets({ field: 'status' }, { workflow: 'checkout' })).toEqual([
        { value: 'completed', count: 1 },
        { value: 'failed', count: 1 },
      ]);
      // Search narrows server-side, before the bound — a match outside the top slice stays reachable.
      expect(await store.runValueFacets({ field: 'workflow' }, {}, { search: 'FUND' })).toEqual([
        { value: 'refund', count: 1 },
      ]);
      // Paging walks the fixed order (count desc, value asc).
      expect(await store.runValueFacets({ field: 'workflow' }, {}, { limit: 1 })).toEqual([
        { value: 'checkout', count: 2 },
      ]);
      expect(
        await store.runValueFacets({ field: 'workflow' }, {}, { limit: 1, offset: 1 }),
      ).toEqual([{ value: 'refund', count: 1 }]);
    });

    t('enumerates value facets for tag and attribute axes, engine tags last', async () => {
      if (!store.runValueFacets) return; // optional store method — callers fall back to a scan
      if (!supportsTagFilter) return; // Prisma + SQLite: array_contains is unsupported there (see flag doc)
      await store.createRun(
        run({
          id: 'a',
          tags: ['etl', 'singleton:abc'],
          searchAttributes: { tier: 'pro', amount: 200 },
        }),
      );
      await store.createRun(
        run({ id: 'b', tags: ['etl'], searchAttributes: { tier: 'pro', amount: 500 } }),
      );
      await store.createRun(
        run({
          id: 'c',
          tags: ['singleton:abc', 'singleton:def'],
          searchAttributes: { tier: 'free' },
        }),
      );

      // Engine-minted per-key tags rank after human tags, however common they are.
      expect(await store.runValueFacets({ field: 'tag' }, {})).toEqual([
        { value: 'etl', count: 2 },
        { value: 'singleton:abc', count: 2 },
        { value: 'singleton:def', count: 1 },
      ]);
      // `attr` lists the keys in use; `attr.<key>` lists the values under one key.
      expect(await store.runValueFacets({ field: 'attributeKey' }, {})).toEqual([
        { value: 'tier', count: 3 },
        { value: 'amount', count: 2 },
      ]);
      expect(await store.runValueFacets({ field: 'attributeValue', key: 'tier' }, {})).toEqual([
        { value: 'pro', count: 2 },
        { value: 'free', count: 1 },
      ]);
      // A key no run carries enumerates to nothing (not an error).
      expect(await store.runValueFacets({ field: 'attributeValue', key: 'nope' }, {})).toEqual([]);
      // Scoped by the rest of the filter: under `tier=pro`, only pro runs are counted.
      expect(
        await store.runValueFacets(
          { field: 'tag' },
          { attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] },
        ),
      ).toEqual([
        { value: 'etl', count: 2 },
        { value: 'singleton:abc', count: 1 },
      ]);
    });

    t(
      're-indexes the search-attribute side-table on update (old values stop matching)',
      async () => {
        await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
        expect(
          (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] })).map(
            (r) => r.id,
          ),
        ).toEqual(['a']);

        await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
        expect(
          (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
            (r) => r.id,
          ),
        ).toEqual(['a']);
        // Old key/value pairs are gone.
        expect(
          await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
        ).toHaveLength(0);
        expect(
          await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
        ).toHaveLength(0);
      },
    );

    t('combines an attribute predicate with a coarse status filter and paginates', async () => {
      await store.createRun(run({ id: 'a', status: 'running', searchAttributes: { amount: 300 } }));
      await store.createRun(
        run({ id: 'b', status: 'completed', searchAttributes: { amount: 400 } }),
      );
      await store.createRun(run({ id: 'c', status: 'running', searchAttributes: { amount: 50 } }));

      const res = await store.listRuns({
        status: 'running',
        attributes: [{ key: 'amount', op: 'gte', value: 100 }],
        size: 10,
      });
      expect(res.map((r) => r.id)).toEqual(['a']);
    });

    // ---- signal waiters & buffered signals --------------------------------------------------

    t('stores, lists by prefix, and atomically takes a signal waiter', async () => {
      await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
      await store.putSignalWaiter({ token: 'approve-2', runId: 'r2', seq: 4 });
      await store.putSignalWaiter({ token: 'other-1', runId: 'r3', seq: 5 });

      expect((await store.listSignalWaiters('approve-')).map((w) => w.token).sort()).toEqual([
        'approve-1',
        'approve-2',
      ]);
      expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
      // Taken exactly once.
      expect(await store.takeSignalWaiter('approve-1')).toBeNull();
    });

    t(
      'round-trips a signal waiter parallelGroup (child-fan tag) through put → take → list',
      async () => {
        // A remote `gather_children` fan threads its group onto each child waiter so the resolving
        // `signal:child:` checkpoint carries it; the store must persist it on the waiter row.
        await store.putSignalWaiter({
          token: 'child:r.child.0',
          runId: 'r',
          seq: 0,
          parallelGroup: 'gather:0',
        });
        // A lone (non-fan) child await carries no group.
        await store.putSignalWaiter({ token: 'child:r.child.9', runId: 'r', seq: 9 });

        const listed = await store.listSignalWaiters('child:');
        expect(listed.find((w) => w.token === 'child:r.child.0')?.parallelGroup).toBe('gather:0');
        expect(listed.find((w) => w.token === 'child:r.child.9')?.parallelGroup).toBeUndefined();

        expect((await store.takeSignalWaiter('child:r.child.0'))?.parallelGroup).toBe('gather:0');
        expect((await store.takeSignalWaiter('child:r.child.9'))?.parallelGroup).toBeUndefined();
      },
    );

    t('buffers signals and takes them FIFO per token', async () => {
      await store.bufferSignal('sig', { n: 1 });
      await store.bufferSignal('sig', { n: 2 });
      await store.bufferSignal('other', { n: 9 });

      expect(await store.takeBufferedSignal('sig')).toEqual({ payload: { n: 1 } });
      expect(await store.takeBufferedSignal('sig')).toEqual({ payload: { n: 2 } });
      expect(await store.takeBufferedSignal('sig')).toBeNull();
      expect(await store.takeBufferedSignal('other')).toEqual({ payload: { n: 9 } });
    });

    t('removeSignalWaiter deletes only the EXACT (token, runId, seq) row', async () => {
      await store.putSignalWaiter({ token: 'go', runId: 'r1', seq: 0 });
      // A different run claims the same token (token is the PK — this REPLACES r1's row).
      await store.putSignalWaiter({ token: 'go', runId: 'r2', seq: 9 });

      // r1's stale cleanup must NOT delete r2's live registration (runId/seq mismatch).
      await store.removeSignalWaiter({ token: 'go', runId: 'r1', seq: 0 });
      expect(await store.listSignalWaiters('go')).toEqual([{ token: 'go', runId: 'r2', seq: 9 }]);

      // Exact match removes it; a second call is a harmless no-op.
      await store.removeSignalWaiter({ token: 'go', runId: 'r2', seq: 9 });
      expect(await store.listSignalWaiters('go')).toEqual([]);
      await store.removeSignalWaiter({ token: 'go', runId: 'r2', seq: 9 });
    });

    t('buffers events (name-keyed), lists oldest-first, and claims a row atomically', async () => {
      await store.bufferEvent({ name: 'ord', payload: { d: 'a' }, id: 'e1', publishedAt: 100 });
      await store.bufferEvent({ name: 'ord', payload: { d: 'b' }, id: 'e2', publishedAt: 200 });
      await store.bufferEvent({ name: 'other', payload: { n: 9 }, id: 'e3', publishedAt: 150 });

      const listed = await store.listBufferedEvents('ord', 10);
      expect(listed).toEqual([
        { id: 'e1', payload: { d: 'a' }, publishedAt: 100 },
        { id: 'e2', payload: { d: 'b' }, publishedAt: 200 },
      ]);
      expect(await store.listBufferedEvents('other', 10)).toEqual([
        { id: 'e3', payload: { n: 9 }, publishedAt: 150 },
      ]);

      // Claim arbitration: first delete wins (true), a second delete of the same id backs off (false).
      expect(await store.removeBufferedEvent('e1')).toBe(true);
      expect(await store.removeBufferedEvent('e1')).toBe(false);
      expect(await store.listBufferedEvents('ord', 10)).toEqual([
        { id: 'e2', payload: { d: 'b' }, publishedAt: 200 },
      ]);
    });

    // ---- transaction (optional) -------------------------------------------------------------

    t('transaction commits the checkpoint atomically and returns the work result', async () => {
      if (!store.transaction) return; // store without transactions (rare); skip
      if (!supportsAsyncTransaction) return; // sync driver (Drizzle + better-sqlite3); skip — see flag doc
      await store.createRun(run());
      const result = await store.transaction(async (tx) => {
        await tx.saveCheckpoint(checkpoint({ seq: 7, name: 'tx-step', output: { paid: true } }));
        return 'ok';
      });
      expect(result).toBe('ok');
      const cp = await store.getCheckpoint('r1', 7);
      expect(cp?.name).toBe('tx-step');
      expect(cp?.output).toEqual({ paid: true });
    });

    // ---- engine end-to-end durability -------------------------------------------------------

    t(
      'runs the engine end-to-end durably, resuming without re-running completed steps',
      async () => {
        const engine = new WorkflowEngine({ store });
        let aRuns = 0;
        let failOnce = true;
        engine.register('wf', '1', async (ctx) => {
          const a = await ctx.localStep('a', async () => {
            aRuns += 1;
            return 10;
          });
          const b = await ctx.localStep('b', async () => {
            if (failOnce) {
              failOnce = false;
              throw new Error('boom');
            }
            return a + 5;
          });
          return b;
        });
        await engine.start('wf', { x: 1 }, 'run1');
        expect((await engine.waitForRun('run1')).status).toBe('failed');
        const resumed = await engine.resume('run1');
        expect(resumed.status).toBe('completed');
        expect(resumed.output).toBe(15);
        // Step `a` checkpointed `completed` the first turn, so replay returns it instead of re-running.
        expect(aRuns).toBe(1);
        // Settle the engine's background work before the store is cleaned up (closed or dropped).
        await engine.drain();
      },
    );
  });
}

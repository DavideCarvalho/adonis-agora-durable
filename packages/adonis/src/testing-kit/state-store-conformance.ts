import { beforeEach, describe, expect, it } from 'vitest';
import {
  type RunStatus,
  type StateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '../index.js';

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
    let skipReason: string | undefined;
    let loggedSkip = false;

    beforeEach(async () => {
      try {
        const ctx = await makeStore();
        store = ctx.store;
        cleanup = ctx.cleanup;
        supportsAsyncTransaction = ctx.supportsAsyncTransaction ?? true;
        supportsTagFilter = ctx.supportsTagFilter ?? true;
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

    /** Register a contract case that no-ops (passes) when the backend was reported unavailable. */
    const t = (label: string, fn: () => Promise<void>): void => {
      it(label, async () => {
        if (skipReason) return;
        await fn();
      });
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

    // ---- checkpoints ------------------------------------------------------------------------

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

    t('orders listRuns newest-first and paginates with limit/offset', async () => {
      await store.createRun(run({ id: 'old', createdAt: new Date('2026-06-11T00:00:00.000Z') }));
      await store.createRun(run({ id: 'mid', createdAt: new Date('2026-06-11T00:00:01.000Z') }));
      await store.createRun(run({ id: 'new', createdAt: new Date('2026-06-11T00:00:02.000Z') }));

      expect((await store.listRuns({})).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.listRuns({ limit: 2 })).map((r) => r.id)).toEqual(['new', 'mid']);
      expect((await store.listRuns({ limit: 2, offset: 1 })).map((r) => r.id)).toEqual([
        'mid',
        'old',
      ]);
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
        limit: 10,
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
      },
    );
  });
}

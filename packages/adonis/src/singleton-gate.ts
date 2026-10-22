import type { SingletonConfig } from './engine.js';
import { SingletonQueueFullError } from './errors.js';
import type { StateStore, WorkflowRun } from './interfaces.js';
import { SINGLETON_ACTIVE_STATUSES, SINGLETON_ADMITTED_TAG } from './singleton-admission.js';

const SINGLETON_RETRY_MS = 1000;
/**
 * Max jitter (ms, each direction) added to {@link SINGLETON_RETRY_MS} so a queue of N gated runs
 * doesn't wake in lockstep and stampede the admission scan. Each retry picks an independent offset
 * in `[-SINGLETON_RETRY_JITTER_MS, +SINGLETON_RETRY_JITTER_MS]`.
 */
const SINGLETON_RETRY_JITTER_MS = 250;

export interface SingletonGateDeps {
  store: Pick<StateStore, 'listRuns' | 'updateRun' | 'updateRunIf' | 'tryAdmitSingleton'>;
  clock: () => number;
  /** Hand a gated run to the run dispatcher (fire-and-forget, like the engine's other dispatches). */
  dispatch: (runId: string) => void;
  /** Resolve a settled run's singleton config from the engine's workflow registry. */
  configFor: (run: WorkflowRun) => SingletonConfig | undefined;
}

/**
 * Per-key serialization for singleton workflows — start-time back-pressure, durable atomic FIFO
 * admission (claimed by the store's {@link StateStore.tryAdmitSingleton}), and notify-on-release wakeups. Extracted from {@link WorkflowEngine} so the whole
 * singleton feature lives in one place instead of being smeared across `start`, `execute`, both run
 * loops, and `cancel`.
 */
export class SingletonGate {
  /** The non-atomic-store warning is printed once per engine, not once per admission. */
  private warnedNonAtomic = false;

  constructor(private readonly deps: SingletonGateDeps) {}

  /** The tag a singleton run carries, so the gate can find others sharing its key. */
  tag(cfg: SingletonConfig, input: unknown): string {
    return `singleton:${cfg.key(input)}`;
  }

  /** Next wake time for a gated run: the base retry delay jittered to avoid a wakeup stampede. */
  retryWakeAt(): number {
    return (
      this.deps.clock() +
      SINGLETON_RETRY_MS +
      Math.floor((Math.random() * 2 - 1) * SINGLETON_RETRY_JITTER_MS)
    );
  }

  /**
   * Reject a start that would grow the same-key backlog past `limit + maxQueueDepth` (counting
   * `pending`/`running`/`suspended`/`blocked` runs sharing the key in one scan). No-op when no
   * `maxQueueDepth` is configured.
   */
  async assertCapacity(workflow: string, cfg: SingletonConfig, input: unknown): Promise<void> {
    if (cfg.maxQueueDepth == null) return;
    const cap = (cfg.limit ?? 1) + cfg.maxQueueDepth;
    const queued = await this.deps.store.listRuns({
      tag: this.tag(cfg, input),
      workflow,
      statuses: SINGLETON_ACTIVE_STATUSES,
    });
    if (queued.length >= cap) {
      throw new SingletonQueueFullError(workflow, cfg.key(input), cfg.maxQueueDepth);
    }
  }

  /**
   * Claim (or confirm) a slot for `run` under its key, atomically in the store: runs already holding
   * a slot keep it, and free slots go to the oldest waiters by `(createdAt, id)`. A denied run is
   * parked `suspended` on a jittered retry timer by the store, in the same critical section — never
   * over a run a concurrent cancel already settled. Holding a slot is durable (a reserved tag), so a
   * holder that sleeps, waits, is recovered on another instance or loses its lease keeps it until it
   * settles terminally.
   */
  async admit(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    const store = this.deps.store;
    if (!store.tryAdmitSingleton) return this.admitByScan(run, cfg);
    const admitted = await store.tryAdmitSingleton(
      run.id,
      this.tag(cfg, run.input),
      run.workflow,
      cfg.limit ?? 1,
      this.retryWakeAt(),
    );
    if (admitted && !run.tags?.includes(SINGLETON_ADMITTED_TAG)) {
      run.tags = [...(run.tags ?? []), SINGLETON_ADMITTED_TAG];
    }
    return admitted;
  }

  /**
   * The pre-atomic admission, kept for a custom store without {@link StateStore.tryAdmitSingleton}
   * so an upgrade doesn't break it: `run` is admitted while it is among the `limit` oldest
   * `running`/`suspended` runs sharing its key by `(createdAt, id)`. It is a read followed by a
   * decision, not a claim, so replicas can briefly over-admit and a same-millisecond start can
   * displace a holder — hence the one-time warning. A denied run is parked on the retry timer here,
   * conditionally, so a concurrent cancel is not overwritten.
   */
  private async admitByScan(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    this.warnNonAtomic();
    const inflight = (
      await this.deps.store.listRuns({
        tag: this.tag(cfg, run.input),
        workflow: run.workflow,
        statuses: ['running', 'suspended'],
      })
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const idx = inflight.findIndex((r) => r.id === run.id);
    if (idx >= 0 && idx < (cfg.limit ?? 1)) return true;
    await this.deps.store.updateRunIf(run.id, SINGLETON_ACTIVE_STATUSES, {
      status: 'suspended',
      wakeAt: this.retryWakeAt(),
      updatedAt: new Date(),
    });
    return false;
  }

  private warnNonAtomic(): void {
    if (this.warnedNonAtomic) return;
    this.warnedNonAtomic = true;
    console.warn(
      '[adonis-durable] singleton admission is NOT atomic on this state store: it does not implement ' +
        'StateStore.tryAdmitSingleton, so the engine falls back to a scan of running/suspended runs. ' +
        'Replicas can briefly admit more than `limit` runs per key, and a same-millisecond start can ' +
        'displace a holder. Implement tryAdmitSingleton (see the exported singletonAdmissionTags / ' +
        'singletonAdmissionDenialPatch helpers and the "Store support" section of the singleton docs) ' +
        'to make admission atomic.',
    );
  }

  /**
   * Notify-on-release: a singleton run settled (freeing a slot), so dispatch the oldest gated
   * (`suspended` + same tag) waiters now instead of waiting for their ~1s retry timer. Each re-checks
   * admission in the executor and runs only if it actually wins a slot, so FIFO/race-free guarantees
   * hold; the durable timer remains the cross-instance/crash fallback.
   */
  async wakeNext(settled: WorkflowRun): Promise<void> {
    const cfg = this.deps.configFor(settled);
    if (!cfg) return;
    const tag = settled.tags?.find((t) => t.startsWith('singleton:'));
    if (!tag) return;
    const gated = (
      await this.deps.store.listRuns({ tag, workflow: settled.workflow, statuses: ['suspended'] })
    )
      // A suspended HOLDER (sleeping, waiting on a signal) is not waiting for a slot — leave it be.
      .filter((r) => !r.tags?.includes(SINGLETON_ADMITTED_TAG))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const next of gated.slice(0, cfg.limit ?? 1)) {
      // Make the run due NOW rather than clearing its retry timer. The dispatch below goes through
      // the configured runDispatcher, which may legitimately be a NO-OP (a poll-only deployment
      // where `durable:work` owns every pickup) — clearing `wakeAt` before a no-op dispatch left
      // the gated run `suspended` with NO wake time, unreachable by every poll path, forever
      // (observed in production). A due `wakeAt` keeps the timer poller as the guaranteed pickup;
      // a dispatch+timer double-drive is safe — the run lease admits one executor and the loser's
      // pickup is a cheap no-op.
      await this.deps.store
        .updateRun(next.id, { wakeAt: this.deps.clock(), updatedAt: new Date() })
        .catch(() => undefined);
      this.deps.dispatch(next.id);
    }
  }
}

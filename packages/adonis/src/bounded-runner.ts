/**
 * Runs keyed tasks at most `limit` at a time; the rest wait in arrival order. A key already waiting
 * is not queued twice: a second submit returns the waiting task's promise. A task starts in a
 * microtask, like a bare `queueMicrotask`, as long as a slot is free.
 *
 * The engine runs in-process work through it (a run it dispatched to itself, a deferred child start)
 * so a wide fan queues run ids instead of holding thousands of turns open at once.
 */
export class BoundedRunner {
  private active = 0;
  private peak = 0;
  private readonly waiting = new Map<string, { task: () => Promise<unknown>; done: () => void }>();
  private readonly waitingPromises = new Map<string, Promise<void>>();

  constructor(private readonly limit: number) {}

  /** Tasks running now plus tasks waiting for a slot. */
  get size(): number {
    return this.active + this.waiting.size;
  }

  /** The most tasks that ever ran at once. */
  get maxActive(): number {
    return this.peak;
  }

  /**
   * Run `task` once a slot is free. The returned promise resolves when the task settles (its failure
   * is swallowed) or is dropped by {@link clear}; it never rejects.
   */
  submit(key: string, task: () => Promise<unknown>): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return new Promise<void>((resolve) => {
        queueMicrotask(() => this.run(task, resolve));
      });
    }
    const queued = this.waitingPromises.get(key);
    if (queued) return queued;
    const promise = new Promise<void>((resolve) => {
      this.waiting.set(key, { task, done: resolve });
    });
    this.waitingPromises.set(key, promise);
    return promise;
  }

  /** Forget every task still waiting for a slot; their promises resolve. */
  clear(): void {
    const dropped = [...this.waiting.values()];
    this.waiting.clear();
    this.waitingPromises.clear();
    for (const entry of dropped) entry.done();
  }

  private run(task: () => Promise<unknown>, done: () => void): void {
    let settled: Promise<unknown>;
    try {
      settled = task();
    } catch {
      settled = Promise.resolve();
    }
    void settled
      .catch(() => undefined)
      .then(() => {
        done();
        const next = this.waiting.entries().next();
        if (next.done) {
          this.active -= 1;
          return;
        }
        const [key, entry] = next.value;
        this.waiting.delete(key);
        this.waitingPromises.delete(key);
        this.run(entry.task, entry.done);
      });
  }
}

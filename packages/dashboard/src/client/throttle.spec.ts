import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from './throttle.js';

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call at once', () => {
    const fn = vi.fn();
    throttle(fn, 1500).call();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst inside the window into one trailing run at its end', () => {
    const fn = vi.fn();
    const t = throttle(fn, 1500);
    t.call();
    for (let i = 0; i < 50; i += 1) t.call();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1499);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never runs twice within one window, however long the burst lasts', () => {
    const runs: number[] = [];
    const t = throttle(() => runs.push(Date.now()), 1500);
    const start = Date.now();
    for (let ms = 0; ms < 6000; ms += 100) {
      t.call();
      vi.advanceTimersByTime(100);
    }
    expect(runs.map((at) => at - start)).toEqual([0, 1500, 3000, 4500, 6000]);
  });

  it('runs at once again after a quiet window', () => {
    const fn = vi.fn();
    const t = throttle(fn, 1500);
    t.call();
    vi.advanceTimersByTime(2000);
    t.call();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the pending trailing run', () => {
    const fn = vi.fn();
    const t = throttle(fn, 1500);
    t.call();
    t.call();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

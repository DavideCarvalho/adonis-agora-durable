import { describe, expect, it } from 'vitest';
import { HandlerLimiter } from '../../../../src/transports/bullmq/handler-limiter.js';

describe('HandlerLimiter', () => {
  it('caps each token on its own', () => {
    const limiter = new HandlerLimiter(2);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.running('a')).toBe(2);
    expect(limiter.running('b')).toBe(1);
  });

  it('serves waiters first in, first out as slots free up', async () => {
    const limiter = new HandlerLimiter(1);
    expect(limiter.tryAcquire('a')).toBe(true);
    const order: number[] = [];
    const first = limiter.acquire('a');
    const second = limiter.acquire('a');
    void first.ready.then(() => order.push(1));
    void second.ready.then(() => order.push(2));
    expect(limiter.waiting('a')).toBe(2);
    limiter.release('a', 10);
    await first.ready;
    expect(order).toEqual([1]);
    limiter.release('a', 30);
    await second.ready;
    expect(order).toEqual([1, 2]);
    expect(limiter.averageMs('a')).toBeCloseTo(14);
  });

  it('a newcomer does not jump the line while others wait', () => {
    const limiter = new HandlerLimiter(1);
    expect(limiter.tryAcquire('a')).toBe(true);
    limiter.acquire('a');
    limiter.release('a');
    // the slot went to the waiter
    expect(limiter.running('a')).toBe(1);
    expect(limiter.tryAcquire('a')).toBe(false);
  });

  it('cancel() leaves the line, or gives back a slot already granted', async () => {
    const limiter = new HandlerLimiter(1);
    expect(limiter.tryAcquire('a')).toBe(true);
    const waiting = limiter.acquire('a');
    waiting.cancel();
    expect(limiter.waiting('a')).toBe(0);
    const granted = limiter.acquire('a');
    limiter.release('a');
    await granted.ready;
    expect(limiter.running('a')).toBe(1);
    granted.cancel();
    granted.cancel();
    expect(limiter.running('a')).toBe(0);
  });

  it('raising the limit starts waiters at once; a bad limit reads as 1', async () => {
    const limiter = new HandlerLimiter(Number.NaN);
    expect(limiter.limit).toBe(1);
    expect(limiter.tryAcquire('a')).toBe(true);
    const next = limiter.acquire('a');
    limiter.setLimit(2);
    await next.ready;
    expect(limiter.running('a')).toBe(2);
  });
});

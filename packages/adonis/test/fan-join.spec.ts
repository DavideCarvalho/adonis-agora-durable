import { describe, expect, it } from 'vitest';
import { allGroup, fanOfWaiter, parseFanGroup, stepFanGroup } from '../src/fan-join.js';

describe('fan groups', () => {
  it('a child fan group carries its size and failFast mark, and parses back', () => {
    expect(allGroup(4, 3000, 'waitAll')).toBe('all:4:n3000');
    expect(allGroup(4, 3000, 'failFast')).toBe('all:4:n3000:failFast');
    expect(parseFanGroup('all:4:n3000:failFast')).toEqual({
      kind: 'all',
      firstSeq: 4,
      size: 3000,
      failFast: true,
    });
  });

  it('parses a child fan group written before it carried a size', () => {
    expect(parseFanGroup('all:4')).toEqual({
      kind: 'all',
      firstSeq: 4,
      size: undefined,
      failFast: false,
    });
    expect(parseFanGroup('all:4:failFast')).toMatchObject({ size: undefined, failFast: true });
  });

  it('parses a step fan group, and nothing else', () => {
    expect(parseFanGroup(stepFanGroup(1, 5000, 'failFast'))).toEqual({
      kind: 'steps',
      firstSeq: 1,
      size: 5000,
      failFast: true,
    });
    expect(parseFanGroup('gather:0')).toBeUndefined();
    expect(parseFanGroup(undefined)).toBeUndefined();
  });

  it('the join barrier reads a waiter of either group shape', () => {
    const waiter = (parallelGroup: string) => ({
      token: 'child:p.all.4.w1.7',
      runId: 'p',
      seq: 11,
      parallelGroup,
    });
    for (const group of ['all:4:failFast', 'all:4:n3000:failFast']) {
      expect(fanOfWaiter(waiter(group))).toEqual({
        waiterPrefix: 'child:p.all.4.w1.',
        failFast: true,
      });
    }
    expect(fanOfWaiter(waiter('all:4:n3000'))).toEqual({
      waiterPrefix: 'child:p.all.4.w1.',
      failFast: false,
    });
  });
});

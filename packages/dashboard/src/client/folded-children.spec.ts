import { describe, expect, it } from 'vitest';
import { foldedChildCount, stepDisplayName } from './folded-children.js';

describe('folded ctx.all groups', () => {
  it('counts the child runs a folded checkpoint stands for', () => {
    const folded = { name: 'fan:p.all.0.', output: { from: 0, values: [1, 2, 3] } };
    expect(foldedChildCount(folded)).toBe(3);
    expect(stepDisplayName(folded)).toBe('3 child runs');
    expect(stepDisplayName({ name: 'fan:p.all.0.w4.', output: { from: 8, values: [9] } })).toBe(
      '1 child run',
    );
  });

  it('leaves every other step alone', () => {
    expect(foldedChildCount({ name: 'signal:child:p.all.0.1', output: { ok: true } })).toBe(
      undefined,
    );
    expect(stepDisplayName({ name: 'extract' })).toBe('extract');
    expect(stepDisplayName({ name: 'fan:x', output: null })).toBe('fan:x');
  });
});

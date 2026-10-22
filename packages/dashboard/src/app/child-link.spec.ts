import { describe, expect, it } from 'vitest';
import { childChips, childDetailIds, childFallbackLabel, childRunIdOf } from './child-link';

describe('childRunIdOf', () => {
  it('extracts the child run id from a ctx.startChild spawn checkpoint', () => {
    expect(childRunIdOf({ name: 'spawn:p1.child.0' })).toBe('p1.child.0');
  });

  it('extracts the child run id from an awaited ctx.child signal checkpoint', () => {
    expect(childRunIdOf({ name: 'signal:child:order-42' })).toBe('order-42');
  });

  it('handles a custom childId that itself contains a colon', () => {
    expect(childRunIdOf({ name: 'spawn:item:99' })).toBe('item:99');
    expect(childRunIdOf({ name: 'signal:child:item:99' })).toBe('item:99');
  });

  it('returns undefined for non-child steps', () => {
    expect(childRunIdOf({ name: 'extraction:setup' })).toBeUndefined();
    expect(childRunIdOf({ name: 'signal:wh:r1:3' })).toBeUndefined(); // webhook
    expect(childRunIdOf({ name: 'signal:breakpoint' })).toBeUndefined(); // breakpoint
    expect(childRunIdOf({ name: 'now' })).toBeUndefined();
  });
});

describe('childDetailIds', () => {
  it('lists distinct child ids in timeline order, skipping non-child steps', () => {
    const timeline = [
      { name: 'setup' },
      { name: 'signal:child:b' },
      { name: 'spawn:a' },
      { name: 'signal:child:b' },
    ];
    expect(childDetailIds(timeline)).toEqual(['b', 'a']);
  });

  it('stops at the limit instead of one fetch per child', () => {
    const timeline = Array.from({ length: 5000 }, (_, i) => ({ name: `signal:child:c${i}` }));
    const ids = childDetailIds(timeline);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('c0');
    expect(ids[49]).toBe('c49');
  });
});

describe('childFallbackLabel', () => {
  it('names a child by its id under the parent, so failed children are tell-apart', () => {
    expect(childFallbackLabel('dpas.all.1.w0.7', 'dpas')).toBe('child all.1.w0.7');
    expect(childFallbackLabel('other-run', 'dpas')).toBe('child other-run');
  });
});

describe('childChips', () => {
  it('lists every child when there are few', () => {
    expect(childChips(['a', 'b'], undefined)).toEqual({ shown: ['a', 'b'], more: 0 });
  });

  it('caps the chips and counts the rest of the listed children', () => {
    const children = Array.from({ length: 120 }, (_, i) => `c${i}`);
    const { shown, more } = childChips(children, undefined);
    expect(shown).toHaveLength(12);
    expect(more).toBe(108);
  });

  it('counts past the listed ids with childCount, when the server capped the list', () => {
    const children = Array.from({ length: 200 }, (_, i) => `c${i}`);
    expect(childChips(children, 40000).more).toBe(39988);
  });
});

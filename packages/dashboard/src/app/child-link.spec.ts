import { describe, expect, it } from 'vitest';
import { childRunIdOf } from './child-link';

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

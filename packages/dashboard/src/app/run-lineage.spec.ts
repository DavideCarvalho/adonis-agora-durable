import { describe, expect, it } from 'vitest';
import { parentRunIdOf, retryOriginOf } from './run-lineage';

describe('run lineage from ids', () => {
  it('child ids link to their parent', () => {
    expect(parentRunIdOf('abc.child.0')).toBe('abc');
    expect(parentRunIdOf('abc.child.12')).toBe('abc');
    expect(parentRunIdOf('abc')).toBeUndefined();
  });

  it('nested children link one level up', () => {
    expect(parentRunIdOf('abc.child.0.child.3')).toBe('abc.child.0');
  });

  it('retry runs link to their origin', () => {
    expect(retryOriginOf('abc~retry~0f201f9b')).toBe('abc');
    expect(retryOriginOf('abc')).toBeUndefined();
  });

  it('a retried child composes: origin is the child, parent is the original parent', () => {
    const id = 'abc.child.0~retry~8115d923';
    expect(retryOriginOf(id)).toBe('abc.child.0');
    expect(parentRunIdOf(id)).toBe('abc');
  });
});

import { describe, expect, it } from 'vitest';
import {
  formatProtocolRange,
  outcomeClass,
  outcomeLabel,
} from '../../src/dashboard/compat-view.js';

describe('compat-view — pure presentation helpers', () => {
  it('maps each negotiation outcome to its badge class', () => {
    expect(outcomeClass('compatible')).toBe('c-ok');
    expect(outcomeClass('degraded')).toBe('c-degraded');
    expect(outcomeClass('incompatible')).toBe('c-bad');
  });

  it('labels each outcome', () => {
    expect(outcomeLabel('compatible')).toBe('compatible');
    expect(outcomeLabel('degraded')).toBe('degraded');
    expect(outcomeLabel('incompatible')).toBe('incompatible');
  });

  it('formats a single-major band as vN and a range as vN–M', () => {
    expect(formatProtocolRange([1, 1])).toBe('v1');
    expect(formatProtocolRange([1, 3])).toBe('v1–3');
  });
});

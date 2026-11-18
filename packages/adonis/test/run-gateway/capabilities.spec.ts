import { describe, expect, it } from 'vitest';
import { capabilityAllows } from '../../src/index.js';

describe('capabilityAllows (the Agora-wide capability rule)', () => {
  it('matches an exact capability', () => {
    expect(capabilityAllows(['tenancy:acme'], 'tenancy:acme')).toBe(true);
    expect(capabilityAllows(['tenancy'], 'tenancy')).toBe(true);
  });

  it('a bare `*` matches everything', () => {
    expect(capabilityAllows(['*'], 'tenancy:acme')).toBe(true);
    expect(capabilityAllows(['*'], 'tenancy')).toBe(true);
    expect(capabilityAllows(['*'], 'durable:runs:read')).toBe(true);
  });

  it('a middle `*` matches exactly one segment', () => {
    expect(capabilityAllows(['durable:*:read'], 'durable:runs:read')).toBe(true);
    expect(capabilityAllows(['durable:*:read'], 'durable:runs:write')).toBe(false);
    expect(capabilityAllows(['durable:*:read'], 'durable:read')).toBe(false);
    expect(capabilityAllows(['durable:*:read'], 'durable:runs:all:read')).toBe(false);
  });

  it('a trailing `*` matches zero or more further segments', () => {
    expect(capabilityAllows(['tenancy:*'], 'tenancy')).toBe(true);
    expect(capabilityAllows(['tenancy:*'], 'tenancy:acme')).toBe(true);
    expect(capabilityAllows(['durable:*'], 'durable:runs:read:all')).toBe(true);
  });

  it('implies nothing beyond the grant', () => {
    expect(capabilityAllows(['tenancy:acme'], 'tenancy:globex')).toBe(false);
    expect(capabilityAllows(['tenancy:acme'], 'tenancy')).toBe(false);
    expect(capabilityAllows(['tenancy:acme'], 'tenancy:acme:admin')).toBe(false);
    expect(capabilityAllows(['tenancy'], 'tenancy:acme')).toBe(false);
  });

  it('ignores unrelated, empty and non-string grants', () => {
    expect(capabilityAllows(['gpu', 'flags:*'], 'tenancy:acme')).toBe(false);
    expect(capabilityAllows([], 'tenancy:acme')).toBe(false);
    expect(capabilityAllows([''], '')).toBe(false);
    expect(capabilityAllows([1, null] as unknown as string[], 'tenancy:acme')).toBe(false);
    expect(capabilityAllows(['nope', 'tenancy:*'], 'tenancy:acme')).toBe(true);
  });
});

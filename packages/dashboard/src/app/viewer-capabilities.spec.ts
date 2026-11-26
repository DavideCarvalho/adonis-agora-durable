import { describe, expect, it } from 'vitest';
import { viewerAllows, viewerLacksReason } from './viewer-capabilities';

describe('viewer capabilities (what the console disables), by the canonical matcher', () => {
  it.each([
    ['durable:runs:write', 'durable:runs:write', true],
    ['durable:read', 'durable:runs:write', false],
    ['durable:console:write', 'durable:schedules:write', true],
    ['durable:console:write', 'durable:read', true],
    ['durable:console:read', 'durable:read', true],
    ['durable:console:*', 'durable:tasks:write', true],
    ['*', 'durable:tasks:write', true],
    // look-alikes grant nothing
    ['*:console:*', 'durable:tasks:write', false],
    ['durable:*:write', 'durable:runs:write', false],
    ['*:read', 'durable:read', false],
    ['durable:console:w*', 'durable:runs:write', false],
  ] as const)('%s → %s: %s', (grant, required, allowed) => {
    expect(viewerAllows([grant], required)).toBe(allowed);
  });

  it('says nothing when the server does not narrow the viewer', () => {
    expect(viewerLacksReason(undefined, 'durable:runs:write')).toBeUndefined();
    expect(viewerLacksReason(['durable:read'], 'durable:runs:write')).toMatch(/durable:runs:write/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type ConsoleCommandVerb,
  consoleVerbAllowed,
  durableConsoleAllows,
  viewerConsoleCapabilities,
} from '../../src/dashboard/federation.js';

/**
 * The one console matcher (SECURITY-UNIFORM-SPEC §10.16b): only exact grants, the literal aliases
 * and trailing-`*` hierarchical grants under `durable:` allow; every look-alike `*` grants nothing.
 */
const CASES: Array<[grant: string, required: string, allowed: boolean]> = [
  // exact
  ['durable:read', 'durable:read', true],
  ['durable:runs:write', 'durable:runs:write', true],
  // literal aliases
  ['*', 'durable:runs:write', true],
  ['durable:*', 'durable:schedules:write', true],
  ['durable:console:*', 'durable:tasks:write', true],
  ['durable:console:write', 'durable:runs:write', true],
  ['durable:console:write', 'durable:read', true], // write implies read
  ['durable:console:read', 'durable:read', true],
  ['durable:console:read', 'durable:runs:write', false],
  // hierarchical (only `*` is the last segment)
  ['durable:runs:*', 'durable:runs:write', true],
  ['durable:runs:*', 'durable:tasks:write', false],
  // look-alikes: a `*` anywhere else grants nothing
  ['*:console:*', 'durable:runs:write', false],
  ['*:console:*', 'durable:read', false],
  ['durable:*:write', 'durable:runs:write', false],
  ['durable:*:write', 'durable:schedules:write', false],
  ['*:read', 'durable:read', false],
  ['*:*', 'durable:read', false],
  ['durable:console:w*', 'durable:runs:write', false],
  ['durable:c*', 'durable:read', false],
  ['durable:r*', 'durable:read', false],
  ['other:console:*', 'durable:read', false],
  ['config:console:*', 'durable:runs:write', false],
  ['durable', 'durable:read', false],
  ['', 'durable:read', false],
];

describe('the console capability matcher (durable)', () => {
  it.each(CASES)('%s → %s: %s', (grant, required, allowed) => {
    expect(durableConsoleAllows([grant], required)).toBe(allowed);
  });

  it('a malformed grant list allows nothing', () => {
    expect(durableConsoleAllows(undefined as never, 'durable:read')).toBe(false);
    expect(durableConsoleAllows([3, null, {}] as never, 'durable:read')).toBe(false);
  });

  const VERBS: Array<[grant: string, verb: ConsoleCommandVerb, allowed: boolean]> = [
    ['durable:console:*', 'cancel', true],
    ['*:console:*', 'cancel', false],
    ['durable:*:write', 'completeTask', false],
    ['durable:*:write', 'triggerSchedule', false],
    ['*:read', 'listSchedules', false],
    ['durable:tasks:write', 'failTask', true],
    ['durable:tasks:write', 'cancel', false],
  ];
  it.each(VERBS)('verb gate: %s → %s: %s', (grant, verb, allowed) => {
    expect(consoleVerbAllowed([grant], verb)).toBe(allowed);
  });

  it('narrowing the viewer drops every look-alike (they reach nothing of durable’s)', () => {
    expect(
      viewerConsoleCapabilities([
        '*:console:*',
        'durable:*:write',
        '*:read',
        'durable:console:w*',
        'durable:runs:write',
      ]),
    ).toEqual(['durable:runs:write']);
    expect(viewerConsoleCapabilities(['*:console:*'], 'read')).toEqual([]);
  });
});

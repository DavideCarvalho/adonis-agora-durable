import { describe, expect, it } from 'vitest';
import { classifyWaitToken, waitTargetsOf } from './waiting-actions.js';

describe('classifyWaitToken: the token prefix carries which console verb answers the wait', () => {
  it('maps a run-scoped update token to the Send-update verb, name extracted', () => {
    expect(classifyWaitToken('update:run-1:set-limit')).toEqual({
      kind: 'update',
      token: 'update:run-1:set-limit',
      name: 'set-limit',
    });
  });

  it('maps a run-scoped task token to the Complete/Fail-task verbs, name extracted', () => {
    expect(classifyWaitToken('task:run-1:review-copy')).toEqual({
      kind: 'task',
      token: 'task:run-1:review-copy',
      name: 'review-copy',
    });
  });

  it('keeps a colon inside the name — only the FIRST separator after the runId splits', () => {
    expect(classifyWaitToken('task:run-1:step:sub')).toEqual({
      kind: 'task',
      token: 'task:run-1:step:sub',
      name: 'step:sub',
    });
  });

  it('treats everything else (plain names, webhooks) as a deliverable signal token', () => {
    expect(classifyWaitToken('approve')).toEqual({ kind: 'signal', token: 'approve' });
    expect(classifyWaitToken('wh:run-1:3')).toEqual({ kind: 'signal', token: 'wh:run-1:3' });
  });

  it('a task/update-LOOKING token with no name falls back to a plain signal, not a broken verb', () => {
    expect(classifyWaitToken('update:oops')).toEqual({ kind: 'signal', token: 'update:oops' });
    expect(classifyWaitToken('task:oops')).toEqual({ kind: 'signal', token: 'task:oops' });
  });

  it('offers NO verb for a breakpoint or child wait — Continue owns the one, the child settles the other', () => {
    expect(classifyWaitToken('bp:run-1:4')).toBeUndefined();
    expect(classifyWaitToken('breakpoint:review')).toBeUndefined();
    expect(classifyWaitToken('child:run-2')).toBeUndefined();
  });
});

describe('waitTargetsOf: tokens come from in-flight signal checkpoints, list-row waiting as fallback', () => {
  const signalStep = (name: string, status: 'pending' | 'completed' = 'pending') => ({
    kind: 'signal' as const,
    status,
    name,
  });

  it('collects pending signal checkpoints (deduped) and skips settled/non-signal steps', () => {
    expect(
      waitTargetsOf([
        { kind: 'remote', status: 'completed', name: 'charge' },
        signalStep('approve'),
        signalStep('approve'),
        signalStep('done', 'completed'),
      ]),
    ).toEqual([{ kind: 'signal', token: 'approve' }]);
  });

  it('falls back to the run row `waiting` stamp only when the timeline names no wait', () => {
    expect(waitTargetsOf([], { on: 'signal', name: 'approve' })).toEqual([
      { kind: 'signal', token: 'approve' },
    ]);
    // The timeline wins when present — the stamp names the SAME wait, offering it twice is noise.
    expect(waitTargetsOf([signalStep('approve')], { on: 'signal', name: 'approve' })).toEqual([
      { kind: 'signal', token: 'approve' },
    ]);
  });

  it('never offers a verb for a child/breakpoint waiting stamp — their names are labels, not tokens', () => {
    expect(waitTargetsOf([], { on: 'child', name: 'run-2' })).toEqual([]);
    expect(waitTargetsOf([], { on: 'breakpoint', name: 'breakpoint' })).toEqual([]);
  });

  it('classifies an update/task-shaped checkpoint token into its own verb', () => {
    expect(
      waitTargetsOf([signalStep('update:run-1:set-limit'), signalStep('task:run-1:qa')]),
    ).toEqual([
      { kind: 'update', token: 'update:run-1:set-limit', name: 'set-limit' },
      { kind: 'task', token: 'task:run-1:qa', name: 'qa' },
    ]);
  });
});

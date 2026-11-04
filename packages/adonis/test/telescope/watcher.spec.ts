import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { WorkflowEngine } from '../../src/engine.js';
import { lifecycleRunId, runCompletedEvent } from '../../src/lifecycle-events.js';
import {
  buildDurableEntry,
  DURABLE_DIAGNOSTIC_EVENTS,
  DurableTelescopeWatcher,
  durableEntryTags,
  durableFailedTriggersProvider,
  traceIdOfTraceparent,
} from '../../src/telescope/index.js';
import type {
  TelescopeEntryLike,
  TelescopeRecordInput,
} from '../../src/telescope/telescope-sdk.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');
const slot = globalThis as Record<symbol, unknown>;

/**
 * Install an emit slot that publishes envelopes on `agora:<lib>:<event>` like
 * `@adonis-agora/diagnostics` does, only when the channel has subscribers.
 */
function installDiagnostics(): void {
  slot[EMIT_SLOT] = (lib: string, event: string, payload: unknown) => {
    const ch = channel(`agora:${lib}:${event}`);
    if (!ch.hasSubscribers) return;
    ch.publish({ v: 1, ts: Date.now(), lib, event, traceId: 'trace-1', payload });
  };
}

const watchers: DurableTelescopeWatcher[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose();
  delete slot[EMIT_SLOT];
  delete slot[CLAIMS_SLOT];
});

function watch(): TelescopeRecordInput[] {
  const recorded: TelescopeRecordInput[] = [];
  const watcher = new DurableTelescopeWatcher();
  watcher.register({ record: (entry) => recorded.push(entry) });
  watchers.push(watcher);
  return recorded;
}

const tagsOf = (recorded: TelescopeRecordInput[], event: string, runId?: string) =>
  recorded.find(
    (e) =>
      (e.content as { event: string }).event === event &&
      (runId === undefined || e.tags?.includes(`run:${runId}`)),
  )?.tags ?? [];

describe('DurableTelescopeWatcher', () => {
  it('records lifecycle tags on both ends of a lifecycle trigger, end to end', async () => {
    installDiagnostics();
    const recorded = watch();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'done', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('strict', '1', async () => 'done', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });

    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      !(
        recorded.some((e) => e.tags?.includes('trigger_failed')) &&
        recorded.some((e) => e.tags?.includes(`source:i1`))
      )
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    off();

    expect(tagsOf(recorded, 'run.triggered')).toEqual(
      expect.arrayContaining(['lib:durable', 'event:run.triggered', 'triggered', `run:${started}`]),
    );
    expect(tagsOf(recorded, 'run.trigger_failed')).toEqual(
      expect.arrayContaining(['trigger_failed', 'subscriber:strict', 'run:i1']),
    );
    expect(tagsOf(recorded, 'run.started', started)).toEqual(
      expect.arrayContaining(['lifecycle', 'source:i1', 'workflow:refresh']),
    );
    expect(tagsOf(recorded, 'run.started', 'i1')).not.toContain('lifecycle');
    expect(recorded[0]).toMatchObject({ type: 'diagnostic', traceId: 'trace-1' });
  });

  it('claims every durable key while registered, so the generic watcher skips them', () => {
    const watcher = new DurableTelescopeWatcher();
    watcher.register({ record: () => {} });
    const claims = slot[CLAIMS_SLOT] as Map<string, number>;
    expect([...claims.keys()].sort()).toEqual(
      DURABLE_DIAGNOSTIC_EVENTS.map((e) => `durable:${e}`).sort(),
    );
    watcher.dispose();
    expect(claims.size).toBe(0);
  });

  it('records entries the Workflows panels read unchanged', async () => {
    const entry = buildDurableEntry({
      v: 1,
      ts: 1,
      lib: 'durable',
      event: 'run.trigger_failed',
      payload: {
        type: 'run.trigger_failed',
        runId: 'i1',
        workflow: 'ingest',
        name: 'strict',
        error: { message: 'bad input' },
      },
    });
    expect(entry.familyHash).toBe('durable:run.trigger_failed');
    const stored: TelescopeEntryLike = { content: entry.content, createdAt: new Date() };
    const res = (await durableFailedTriggersProvider().resolve(
      {},
      {
        store: { list: async () => [stored] },
        container: { make: async () => ({}) as never },
        config: {},
      },
    )) as { rows: Array<Record<string, string>> };
    expect(res.rows).toEqual([
      expect.objectContaining({ runId: 'i1', subscriber: 'strict', error: 'bad input' }),
    ]);
  });
});

describe('durableEntryTags', () => {
  it('tags a lifecycle-started run with its source and the source trace', () => {
    expect(
      durableEntryTags({
        type: 'run.started',
        runId: 'evt:i1:completed:refresh',
        workflow: 'refresh',
        lifecycleSourceRunId: 'i1',
        lifecycleKind: 'completed',
        sourceTraceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      }),
    ).toEqual([
      'durable',
      'run.started',
      'run:evt:i1:completed:refresh',
      'workflow:refresh',
      'lifecycle',
      'source:i1',
      'sourceTrace:0af7651916cd43dd8448eb211c80319c',
    ]);
  });

  it('tags routing, child runs and step kinds', () => {
    expect(
      durableEntryTags({
        type: 'run.routed',
        runId: 'p.child.0',
        parentRunId: 'p',
        error: { message: 'x', code: 'E1' },
      }),
    ).toEqual(['durable', 'run.routed', 'run:p.child.0', 'parent:p', 'routed', 'onError:E1']);
    expect(durableEntryTags({ type: 'step.failed', runId: 'r', kind: 'local' })).toEqual([
      'durable',
      'step.failed',
      'run:r',
      'kind:local',
    ]);
  });

  it('reads a trace id only from a valid traceparent', () => {
    expect(traceIdOfTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
    expect(traceIdOfTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBe(
      undefined,
    );
    expect(traceIdOfTraceparent('nope')).toBeUndefined();
    expect(traceIdOfTraceparent(undefined)).toBeUndefined();
  });
});

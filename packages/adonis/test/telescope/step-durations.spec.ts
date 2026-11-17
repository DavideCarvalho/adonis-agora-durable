import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import type { EngineEvent } from '../../src/interfaces.js';
import {
  buildDurableEntry,
  DurableTelescopeWatcher,
  durableEntryFamily,
  durableTelescopeExtension,
  registerControlPlaneWatcher,
} from '../../src/telescope/index.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');
const RUNTIME_SLOT = Symbol.for('@agora/telescope:runtime');
const AUTO_SLOT = Symbol.for('@agora/durable:telescope-auto-watcher');
const slot = globalThis as Record<symbol, unknown>;

interface Runtime {
  store: null;
  enabledWatchers: Set<string>;
  tenantWatchers: Set<string>;
}

function installRuntime(): Runtime {
  const runtime: Runtime = {
    store: null,
    enabledWatchers: new Set(['request']),
    tenantWatchers: new Set(),
  };
  slot[RUNTIME_SLOT] = runtime;
  return runtime;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  (slot[AUTO_SLOT] as { watcher?: DurableTelescopeWatcher } | undefined)?.watcher?.dispose();
  delete slot[AUTO_SLOT];
  delete slot[EMIT_SLOT];
  delete slot[CLAIMS_SLOT];
  delete slot[RUNTIME_SLOT];
});

describe('durable step durations in Telescope', () => {
  it("a step's outcome is named in its family and timed; other events keep `durable:<event>`", () => {
    const completed = buildDurableEntry({
      ts: 1,
      lib: 'durable',
      event: 'step.completed',
      payload: { type: 'step.completed', runId: 'r1', name: 'index-thesis', durationMs: 1234.6 },
      durationMs: 1234.6,
    });
    expect(completed.familyHash).toBe('durable:step.completed:index-thesis');
    expect(completed.durationMs).toBe(1235);

    // An older diagnostics package leaves the envelope without it: the payload's is used.
    const failed = buildDurableEntry({
      ts: 1,
      lib: 'durable',
      event: 'step.failed',
      payload: { type: 'step.failed', runId: 'r1', name: 'index-thesis', durationMs: 80 },
    });
    expect(failed.familyHash).toBe('durable:step.failed:index-thesis');
    expect(failed.durationMs).toBe(80);

    const run = buildDurableEntry({
      ts: 1,
      lib: 'durable',
      event: 'run.completed',
      payload: { type: 'run.completed', runId: 'r1', workflow: 'ingest' },
    });
    expect(run.familyHash).toBe('durable:run.completed');
    expect(run.durationMs).toBeNull();
  });

  it('a long step name is cut to the 255 characters Telescope stores', () => {
    expect(durableEntryFamily('step.completed', { name: 'x'.repeat(400) })).toHaveLength(255);
    expect(durableEntryFamily('step.completed', {})).toBe('durable:step.completed');
    expect(durableEntryFamily('step.started', { name: 'a' })).toBe('durable:step.started');
  });

  it('the bridge stamps a step duration on the envelope options', () => {
    const calls: Array<{ event: string; options: unknown }> = [];
    slot[EMIT_SLOT] = (_lib: string, event: string, _payload: unknown, options?: unknown) => {
      calls.push({ event, options });
    };
    let listener: ((event: EngineEvent) => void) | undefined;
    cleanups.push(
      attachDurableDiagnostics({
        subscribe(fn) {
          listener = fn;
          return () => undefined;
        },
      }),
    );
    const at = new Date();
    listener?.({
      type: 'step.completed',
      runId: 'r1',
      name: 'parse',
      durationMs: 42,
      at,
    } as EngineEvent);
    listener?.({ type: 'run.started', runId: 'r1', workflow: 'ingest', at } as EngineEvent);
    expect(calls).toEqual([
      { event: 'step.completed', options: { durationMs: 42 } },
      // An event that measured nothing passes no options, as before.
      { event: 'run.started', options: undefined },
    ]);
  });

  it('a registered watcher names `durable` in the watchers Telescope reports, until disposed', () => {
    const runtime = installRuntime();
    const watcher = new DurableTelescopeWatcher();
    watcher.register({ record: () => undefined });
    expect([...runtime.enabledWatchers]).toEqual(['request', 'durable']);
    watcher.dispose();
    expect([...runtime.enabledWatchers]).toEqual(['request']);
  });

  it('a host watcher replacing the auto one keeps `durable` listed', () => {
    const runtime = installRuntime();
    cleanups.push(registerControlPlaneWatcher({ record: () => undefined }));
    const host = new DurableTelescopeWatcher();
    host.register({ record: () => undefined });
    cleanups.push(() => host.dispose());
    expect(runtime.enabledWatchers.has('durable')).toBe(true);
  });

  it('on a control plane `durable` is a watcher it runs for its tenants', () => {
    const runtime = installRuntime();
    const release = registerControlPlaneWatcher({ record: () => undefined });
    expect(runtime.tenantWatchers.has('durable')).toBe(true);
    release();
    expect(runtime.tenantWatchers.has('durable')).toBe(false);
  });

  it('the extension records durable events at boot, unless a watcher is already wired', () => {
    const runtime = installRuntime();
    durableTelescopeExtension().entryTypes?.({} as never);
    expect(runtime.enabledWatchers.has('durable')).toBe(true);
    expect((slot[AUTO_SLOT] as { watcher?: unknown }).watcher).toBeInstanceOf(
      DurableTelescopeWatcher,
    );
  });
});

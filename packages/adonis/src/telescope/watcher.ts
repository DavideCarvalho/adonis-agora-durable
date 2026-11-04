import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EngineEvent, EngineEventType } from '../interfaces.js';
import type { TelescopeRecordInput, WatcherContext } from './telescope-sdk.js';

/** Every engine event type the diagnostics bridge publishes as `agora:durable:<type>`. */
export const DURABLE_DIAGNOSTIC_EVENTS = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.suspended',
  'step.started',
  'step.completed',
  'step.failed',
  'step.progress',
  'capability.unavailable',
  'protocol.incompatible',
  'run.routed',
  'run.unrouted',
  'run.triggered',
  'run.trigger_failed',
] as const satisfies readonly EngineEventType[];

// A new engine event type must be added above, or the watcher would leave it to the generic one.
type Unlisted = Exclude<EngineEventType, (typeof DURABLE_DIAGNOSTIC_EVENTS)[number]>;
const allListed: Unlisted extends never ? true : Unlisted = true;
void allListed;

/** The claim registry `@adonis-agora/diagnostics` keeps (`lib:event` → active claims). */
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');

function claimsRegistry(): Map<string, number> {
  const g = globalThis as Record<symbol, unknown>;
  let registry = g[CLAIMS_SLOT] as Map<string, number> | undefined;
  if (registry === undefined) {
    registry = new Map<string, number>();
    g[CLAIMS_SLOT] = registry;
  }
  return registry;
}

/** Claim `durable:<event>` for every event, reference-counted; returns the idempotent release. */
function claimDurableDiagnostics(events: readonly string[]): () => void {
  const registry = claimsRegistry();
  const keys = events.map((event) => `durable:${event}`);
  for (const key of keys) registry.set(key, (registry.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = registry.get(key);
      if (count === undefined) continue;
      if (count <= 1) registry.delete(key);
      else registry.set(key, count - 1);
    }
  };
}

/** The envelope `@adonis-agora/diagnostics` publishes on each channel (structural mirror). */
interface DiagnosticEnvelope {
  v?: number;
  ts: number;
  lib: string;
  event: string;
  traceId?: string;
  payload: unknown;
  durationMs?: number;
}

/** What the diagnostics bridge adds to an {@link EngineEvent} payload. */
type BridgedEvent = Partial<EngineEvent> & {
  parentRunId?: string;
  lifecycleSourceRunId?: string;
  lifecycleKind?: string;
};

/** The trace id of a W3C `traceparent`, or undefined when it is not a valid one. */
export function traceIdOfTraceparent(traceparent: string | undefined): string | undefined {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
    traceparent?.trim().toLowerCase() ?? '',
  );
  return m?.[1] && !/^0+$/.test(m[1]) ? m[1] : undefined;
}

/**
 * The tags of a durable entry beyond the generic `lib:durable` / `event:<type>` / `trace:<id>`:
 * `durable`, the event type, `run:<id>`, `parent:<id>` for a child run, `workflow:<name>`,
 * `kind:<step kind>`, `failed` on `run.failed`, `routed`/`unrouted` with `onError:<code|*>`,
 * `triggered` with the started run's `run:<id>`, `trigger_failed` with `subscriber:<name>`, and on
 * the `run.started` of a run a lifecycle event started, `lifecycle`, `source:<source run id>` and
 * `sourceTrace:<trace id>` when the source recorded its span.
 */
export function durableEntryTags(event: BridgedEvent): string[] {
  const type = event.type ?? 'unknown';
  const tags = ['durable', type];
  if (event.runId) tags.push(`run:${event.runId}`);
  if (event.parentRunId) tags.push(`parent:${event.parentRunId}`);
  if (event.workflow) tags.push(`workflow:${event.workflow}`);
  if (event.kind) tags.push(`kind:${event.kind}`);
  if (type === 'run.failed') tags.push('failed');
  if (type === 'run.routed' || type === 'run.unrouted') {
    tags.push(type === 'run.routed' ? 'routed' : 'unrouted');
    tags.push(`onError:${event.error?.code ?? '*'}`);
  }
  // Tagged with both runs, so the link shows in the settled run's trail and the started run's.
  if (type === 'run.triggered') {
    tags.push('triggered');
    if (event.triggeredRunId) tags.push(`run:${event.triggeredRunId}`);
  }
  if (type === 'run.trigger_failed') tags.push('trigger_failed', `subscriber:${event.name}`);
  if (type === 'run.started' && event.lifecycleSourceRunId) {
    tags.push('lifecycle', `source:${event.lifecycleSourceRunId}`);
    const traceId = traceIdOfTraceparent(event.sourceTraceparent);
    if (traceId) tags.push(`sourceTrace:${traceId}`);
  }
  return tags;
}

/**
 * The entry the watcher records for one `agora:durable:*` envelope: the generic diagnostics
 * watcher's entry (`type: 'diagnostic'`, `familyHash: 'durable:<event>'`, the envelope as content,
 * `lib:durable` / `event:<type>` / `trace:<id>` tags), plus {@link durableEntryTags}. The same type,
 * family and content, so the Workflows dashboard's entry-backed panels read it unchanged.
 */
export function buildDurableEntry(envelope: DiagnosticEnvelope): TelescopeRecordInput {
  const traceId = envelope.traceId ?? null;
  const durationMs = envelope.durationMs ?? null;
  const payload =
    envelope.payload !== null && typeof envelope.payload === 'object'
      ? (envelope.payload as BridgedEvent)
      : {};
  return {
    type: 'diagnostic',
    familyHash: `${envelope.lib}:${envelope.event}`,
    tags: [
      `lib:${envelope.lib}`,
      `event:${envelope.event}`,
      ...(traceId ? [`trace:${traceId}`] : []),
      ...durableEntryTags({
        ...payload,
        type: (payload.type ?? envelope.event) as EngineEventType,
      }),
    ],
    content: {
      v: envelope.v ?? null,
      lib: envelope.lib,
      event: envelope.event,
      ts: envelope.ts,
      traceId,
      payload: envelope.payload,
      durationMs,
    },
    traceId,
    durationMs,
  };
}

/**
 * A Telescope watcher for durable's events: records each `agora:durable:<type>` diagnostics event
 * as the generic diagnostics watcher would, plus tags for the run, its parent, its workflow and its
 * lifecycle links (see {@link durableEntryTags}), so `source:<run>`, `subscriber:<name>`,
 * `trigger_failed` and `lifecycle` are searchable in Telescope.
 *
 * `@adonis-agora/telescope`'s `TelescopeExtension` contract takes no watchers, so a host wires it by
 * hand, to Telescope's `safeRecord` (which honours its pause, heartbeat and self-observation rules):
 *
 * ```ts
 * import { safeRecord } from '@adonis-agora/telescope/watchers'
 * import { DurableTelescopeWatcher } from '@adonis-agora/durable/telescope'
 *
 * new DurableTelescopeWatcher().register({ record: (entry) => safeRecord(entry, 'durable') })
 * ```
 *
 * `register()` claims every `durable:<type>` key in `@adonis-agora/diagnostics`' claim registry,
 * so the generic watcher (from `@adonis-agora/telescope` 0.6.0) skips them and nothing is recorded
 * twice; `dispose()` releases the claims and the channel subscriptions. Neither package is imported.
 */
export class DurableTelescopeWatcher {
  private readonly disposers: Array<() => void> = [];

  register(ctx: WatcherContext): void {
    this.dispose();
    this.disposers.push(claimDurableDiagnostics(DURABLE_DIAGNOSTIC_EVENTS));
    for (const event of DURABLE_DIAGNOSTIC_EVENTS) {
      const channel = `agora:durable:${event}`;
      const onMessage = (message: unknown): void => {
        const envelope = message as DiagnosticEnvelope | null;
        if (envelope === null || typeof envelope !== 'object' || envelope.lib !== 'durable') return;
        try {
          ctx.record(buildDurableEntry(envelope));
        } catch {
          // Recording must never break the engine that emitted the event.
        }
      };
      subscribe(channel, onMessage);
      this.disposers.push(() => unsubscribe(channel, onMessage));
    }
  }

  /** Release the claims and detach every channel subscription. */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}

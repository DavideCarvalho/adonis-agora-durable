import { workflowMeta, type WorkflowClass } from './workflow-ref.js';

/**
 * Event-triggered workflows: a workflow class declares which **external** events start a
 * run — the Adonis emitter (`@OnEvent`) and/or the `@adonis-agora/diagnostics` bus
 * (`@OnDiagnostic`). The durable provider bridges those buses into the engine (a fresh
 * run per matching event, payload as input), mirroring how `static schedule`/`@Scheduled`
 * bridge time into the engine.
 *
 * Two authoring forms, exactly like schedules:
 * - `@OnEvent(...)` / `@OnDiagnostic(...)` decorators (named params), and
 * - a colocated `static on = [...]` literal — the decorators only stamp `static on`.
 *
 * ```ts
 * @OnDiagnostic({ lib: 'payments', event: 'payment.succeeded' })
 * @OnEvent({ event: 'agora:payments:payment.succeeded' })
 * export class ProcessPaymentWorkflow extends BaseWorkflow {
 *   static workflow = { name: 'process-payment' }
 *   async run(ctx, input) { /* input = the event payload *\/ }
 * }
 * ```
 */

/** A trigger fed by the AdonisJS emitter. Exact event names only (the emitter has no wildcard). */
export interface EmitterTriggerConfig {
  /** The emitter event name, e.g. `'agora:payments:payment.succeeded'`. */
  event: string;
}

/** A trigger fed by the `@adonis-agora/diagnostics` bus (`agora:<lib>:<event>` channels). */
export interface DiagnosticsTriggerConfig {
  /** The diagnostics lib to listen to, e.g. `'payments'`. */
  lib: string;
  /**
   * Exact event within the lib (e.g. `'payment.succeeded'`), a regex over events, or omit
   * to match every event of the lib.
   */
  event?: string | RegExp;
}

/** One colocated event trigger (the `static on` entry), discriminated by source. */
export type WorkflowEventTrigger =
  | ({ source: 'emitter' } & EmitterTriggerConfig)
  | ({ source: 'diagnostics' } & DiagnosticsTriggerConfig);

/** A normalized trigger: the workflow name filled in, ready for the bridge/engine. */
export type NormalizedEventTrigger =
  | ({ source: 'emitter' } & EmitterTriggerConfig & { workflow: string })
  | ({ source: 'diagnostics' } & DiagnosticsTriggerConfig & { workflow: string });

/**
 * The canonical engine event name an EXACT trigger maps to — the name the workflow
 * registers under `onEvent` and the bridge publishes with:
 * - emitter: the literal event name,
 * - diagnostics: the channel name `agora:<lib>:<event>`.
 * Returns `null` for regex/any triggers (the bridge starts those directly).
 */
export function eventTriggerCanonicalName(
  trigger: NormalizedEventTrigger,
): string | null {
  if (trigger.source === 'emitter') return trigger.event;
  if (trigger.event === undefined) return null;
  return typeof trigger.event === 'string' ? `agora:${trigger.lib}:${trigger.event}` : null;
}

/** Read a class's colocated event triggers (`static on`) and fill the workflow name. */
export function workflowEvents(target: unknown): NormalizedEventTrigger[] {
  const meta = workflowMeta(target);
  if (!meta) return [];
  const raw = (target as { on?: WorkflowEventTrigger | WorkflowEventTrigger[] }).on;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((t) => ({ ...t, workflow: meta.name }));
}

/** Stamp `static on` (prepend, mirroring {@link Scheduled}). */
function stampOn(
  target: unknown,
  config: WorkflowEventTrigger | WorkflowEventTrigger[],
): void {
  const cls = target as { on?: WorkflowEventTrigger | WorkflowEventTrigger[] };
  const existing = cls.on === undefined ? [] : Array.isArray(cls.on) ? cls.on : [cls.on];
  const added = Array.isArray(config) ? config : [config];
  cls.on = [...added, ...existing];
}

/**
 * Listen to an exact event on the **AdonisJS emitter** and start this workflow with the
 * event payload. Named params:
 *
 * ```ts
 * @OnEvent({ event: 'agora:payments:payment.succeeded' })
 * ```
 */
export function OnEvent(config: EmitterTriggerConfig): ClassDecorator {
  return (target) => stampOn(target, { source: 'emitter', ...config });
}

/**
 * Listen to an event on the **`@adonis-agora/diagnostics` bus** (`agora:<lib>:<event>`
 * channel) and start this workflow with the event payload. Named params:
 *
 * ```ts
 * @OnDiagnostic({ lib: 'payments', event: 'payment.succeeded' }) // exact
 * @OnDiagnostic({ lib: 'payments', event: /^payment\./ })        // regex over events
 * @OnDiagnostic({ lib: 'payments' })                             // every event of the lib
 * ```
 */
export function OnDiagnostic(config: DiagnosticsTriggerConfig): ClassDecorator {
  return (target) => stampOn(target, { source: 'diagnostics', ...config });
}

/** Workflow-class shape used by the bridge to start a run on a matching event. */
export type EventTriggeredWorkflow = WorkflowClass;
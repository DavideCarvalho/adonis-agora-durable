import { isDiagnosticsDeliveryEvent } from './diagnostics/transport.js';
import { parentRunIdOf } from './fan-join.js';
import type { EngineEvent } from './interfaces.js';
import { lifecycleSourceOf } from './lifecycle-events.js';
import { isRemoteEvent } from './remote-event.js';
import { runTraceId } from './run-trace.js';

/** The minimal engine surface the bridge needs: a lifecycle-event subscription. */
export interface DurableEventSource {
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

/** The `@adonis-agora/diagnostics` emit capability, published on this slot at that package's module load. */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (
  lib: string,
  event: string,
  payload: unknown,
  options?: { traceId?: string; app?: string; durationMs?: number },
) => void;

/** Options for {@link attachDurableDiagnostics}. */
export interface DurableDiagnosticsOptions {
  /**
   * Also forward the events this instance only HEARD from other instances over the control plane.
   * Default `false`: with a control plane configured, every pod receives every other pod's lifecycle
   * events, so forwarding them made each pod's Telescope record each event once per pod (a
   * three-pod fleet counted every `run.completed` three times). Set it on a pod that should mirror
   * the whole fleet into a recorder of its own, and nowhere else.
   */
  includeRemote?: boolean | undefined;
  /**
   * Attribute each event to the tenant app whose run it is: a control plane sets it, so it is the one
   * place every tenant's workflow lifecycle is recorded (see {@link TenantAttribution}). Every
   * forwarded event of a tenant's run then carries `app: <tenant partition>`, step events included.
   * Omitted (standalone): events are forwarded exactly as the engine produced them.
   */
  tenants?: TenantAttribution | undefined;
}

/**
 * How the bridge finds the tenant app of a run on a control plane. A tenant's runs live in the
 * worker-pool partition the tenant's token verified to (`run.namespace`); `run.*` events carry it,
 * `step.*` events do not, so the bridge remembers it per run and, for a run it has not seen an event
 * of yet (a run resumed after a restart, another pod's run), reads it once.
 */
export interface TenantAttribution {
  /** The namespace (tenant partition) of `runId`, or `undefined` when the run is unknown. */
  namespaceOf(runId: string): Promise<string | undefined>;
  /**
   * The control plane's own namespaces: runs in these are its own, not a tenant's, and get no `app`.
   * `'default'` and an absent namespace are always the control plane's.
   */
  own?: readonly string[] | undefined;
  /** How many run → app answers to keep (oldest dropped first). Default 10,000. */
  cacheSize?: number | undefined;
  /**
   * How long one read may take before the event is forwarded unattributed (the run's next event
   * reads again). Default 5,000 ms.
   */
  lookupTimeoutMs?: number | undefined;
}

/** A tenant app of `namespace`, or `undefined` for the control plane's own runs. */
function tenantAppOf(namespace: string | undefined, own: ReadonlySet<string>): string | undefined {
  if (namespace === undefined || namespace === '' || namespace === 'default') return undefined;
  return own.has(namespace) ? undefined : namespace;
}

/**
 * Remembers which app each run belongs to and stamps it on that run's events, in emission order. An
 * event whose run is not known yet waits for one store read; that run's later events wait behind it
 * (a run's `step.completed` is never forwarded before its `step.started`), other runs' do not. A read
 * that fails or takes longer than `lookupTimeoutMs` forwards the event unattributed and is retried on
 * the run's next event.
 */
class TenantStamper {
  readonly #lookup: (runId: string) => Promise<string | undefined>;
  readonly #own: ReadonlySet<string>;
  readonly #max: number;
  readonly #timeoutMs: number;
  /** runId → app (`null`: the control plane's own run). */
  readonly #apps = new Map<string, string | null>();
  /** runId → the last queued event of that run, while one is waiting on a read. */
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: TenantAttribution) {
    this.#lookup = (runId) => options.namespaceOf(runId);
    this.#own = new Set(options.own ?? []);
    this.#max = Math.max(1, options.cacheSize ?? 10_000);
    this.#timeoutMs = Math.max(1, options.lookupTimeoutMs ?? 5_000);
  }

  /** Call `forward` with `event` stamped with its app (when it has one), now or once it is known. */
  stamp(event: EngineEvent, forward: (event: EngineEvent & { app?: string }) => void): void {
    const runId = event.runId;
    const tail = this.#tails.get(runId);
    if (tail === undefined) {
      const known = this.#known(event);
      if (known !== undefined) {
        forward(this.#with(event, known));
        this.#settle(event);
        return;
      }
    }
    const next = (tail ?? Promise.resolve()).then(async () => {
      try {
        let app = this.#known(event);
        if (app === undefined) {
          const namespace = await this.#read(runId);
          if (namespace === FAILED) {
            app = null; // not remembered: the run's next event reads again
          } else {
            app = tenantAppOf(namespace, this.#own) ?? null;
            this.#remember(runId, app);
          }
        }
        forward(this.#with(event, app));
        this.#settle(event);
      } catch {
        // Recording must never break the engine, nor stall the events behind this one.
      }
    });
    this.#tails.set(runId, next);
    void next.then(() => {
      if (this.#tails.get(runId) === next) this.#tails.delete(runId);
    });
  }

  /** The run's namespace, or {@link FAILED} when the read threw or did not answer in time. */
  async #read(runId: string): Promise<string | undefined | typeof FAILED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof FAILED>((resolve) => {
      timer = setTimeout(() => resolve(FAILED), this.#timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([this.#lookup(runId).catch((): typeof FAILED => FAILED), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The app of `event`'s run when it can be answered without a read (`null`: no app). */
  #known(event: EngineEvent): string | null | undefined {
    if (event.namespace !== undefined) {
      const app = tenantAppOf(event.namespace, this.#own) ?? null;
      this.#remember(event.runId, app);
      return app;
    }
    return this.#apps.get(event.runId);
  }

  /** A tenant's event carries its app, and its partition as `namespace` (step events have none). */
  #with(event: EngineEvent, app: string | null): EngineEvent & { app?: string } {
    if (app === null) return event;
    return event.namespace === undefined ? { ...event, namespace: app, app } : { ...event, app };
  }

  #remember(runId: string, app: string | null): void {
    if (this.#apps.has(runId)) this.#apps.delete(runId);
    else if (this.#apps.size >= this.#max) {
      const oldest = this.#apps.keys().next().value;
      if (oldest !== undefined) this.#apps.delete(oldest);
    }
    this.#apps.set(runId, app);
  }

  /** A settled run emits nothing more: forget it. */
  #settle(event: EngineEvent): void {
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      this.#apps.delete(event.runId);
    }
  }
}

/** A namespace read that threw or timed out. */
const FAILED: unique symbol = Symbol('failed');

/**
 * Bridge engine lifecycle events onto the `@adonis-agora/diagnostics` bus as `agora:durable:<type>`
 * (e.g. `agora:durable:run.failed`); the whole {@link EngineEvent} is the payload. The emit
 * capability is read STRUCTURALLY from its global slot per event — durable never imports or depends
 * on `@adonis-agora/diagnostics`, and when diagnostics isn't installed the slot is empty and this is an
 * inert subscription.
 *
 * One bridge lights up everything downstream of the diagnostics hub at once: `onDiagnostic('durable')`
 * subscribers, the Telescope generic watcher (which auto-captures every channel), the cross-process
 * relays, and the OTel bridge (each event recorded on the active span). `emit` short-circuits on
 * `hasSubscribers`, so an unsubscribed channel costs nothing, and it never throws back into the
 * engine. Only the events THIS instance produced are forwarded by default (see
 * {@link DurableDiagnosticsOptions.includeRemote}), so a fleet records each event once; all event
 * types are forwarded — filtering is the subscriber's job — except those of the runs that deliver
 * diagnostics listener calls (`transports.durable()`), which would otherwise feed themselves. An event of a child run
 * the engine started (`ctx.all`, `ctx.child`, `ctx.startChild` without a caller-chosen id) also
 * carries `parentRunId`: each child is its own run, so that field is how a subscriber (a Telescope
 * search, say) finds every child of one parent, a whole `ctx.all` fan included. An event of a run a
 * lifecycle event started (an `@OnWorkflowCompleted` / `@OnWorkflowFailed` subscriber) carries
 * `lifecycleSourceRunId` and `lifecycleKind`, the settled run that started it and how that run
 * ended, so its entries link back to the source run; its `run.started` also carries the source's
 * `sourceTraceparent` when the engine knows it.
 *
 * With {@link DurableDiagnosticsOptions.tenants} (what the provider passes on a control plane), every
 * event of a tenant's run also carries `app`, the tenant's partition, so one control plane records
 * the lifecycle of every tenant's workflows, each attributed to its app, and each of those events is
 * emitted with its run's trace id ({@link runTraceId}): the trace the tenant pod records the step's
 * own work in.
 *
 * @returns an unsubscribe function that detaches the bridge from the engine.
 */
export function attachDurableDiagnostics(
  engine: DurableEventSource,
  options: DurableDiagnosticsOptions = {},
): () => void {
  const includeRemote = options.includeRemote === true;
  const stamper = options.tenants ? new TenantStamper(options.tenants) : undefined;
  return engine.subscribe((event: EngineEvent) => {
    if (!includeRemote && isRemoteEvent(event)) return;
    // A run delivering a diagnostics listener call (`transports.durable()`) is not echoed back onto
    // the bus: a listener on `durable` events would start a delivery run for each one, forever.
    if (isDiagnosticsDeliveryEvent(event)) return;
    if (typeof (globalThis as Record<symbol, unknown>)[EMIT_SLOT] !== 'function') return;
    if (stamper) stamper.stamp(event, forwardTenant);
    else forward(event);
  });
}

/**
 * Emit an event a control plane attributed: a tenant's run names its app on the envelope (`app`, the
 * field `@adonis-agora/diagnostics` 1.0.0-rc.6 stamps and Telescope tags `app:<name>` from) as well
 * as in the payload, and is recorded in its run trace ({@link runTraceId}), the one its tenant pod
 * records the step's own work in.
 */
function forwardTenant(event: EngineEvent & { app?: string }): void {
  if (event.app === undefined) forward(event);
  else forward(event, { traceId: runTraceId(event.runId), app: event.app });
}

/**
 * Emit one engine event on the diagnostics bus, with the child / lifecycle links it implies. An event
 * that measured its work (`step.completed` / `step.failed`) also stamps its `durationMs` on the
 * envelope, the field Telescope stores in its `duration_ms` column.
 */
function forward(event: EngineEvent, options?: { traceId: string; app: string }): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit !== 'function') return;
  const parentRunId = parentRunIdOf(event.runId);
  const source = event.workflow
    ? lifecycleSourceOf({ id: event.runId, workflow: event.workflow })
    : undefined;
  const durationMs =
    typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? Math.max(0, Math.round(event.durationMs))
      : undefined;
  const emitOptions = durationMs === undefined ? options : { ...(options ?? {}), durationMs };
  emit(
    'durable',
    event.type,
    parentRunId || source
      ? {
          ...event,
          ...(parentRunId ? { parentRunId } : {}),
          ...(source ? { lifecycleSourceRunId: source.runId, lifecycleKind: source.kind } : {}),
        }
      : event,
    ...(emitOptions !== undefined ? [emitOptions] : []),
  );
}

import type {
  DeliveredEvent,
  DeliveryTransportContext,
  DurableTransportConfig,
  ListenerDelivery,
  ListenerDeliveryTransport,
} from '@adonis-agora/diagnostics/delivery';
import type { ApplicationService } from '@adonisjs/core/types';
import { WorkflowEngine } from '../engine.js';
import { FatalError, RunAlreadyExistsError } from '../errors.js';
import type { StepOptions, WorkflowCtx } from '../interfaces.js';

/** The internal workflow every diagnostics listener delivery runs as. */
export const DIAGNOSTICS_LISTENER_WORKFLOW = 'durable.diagnostics.listener';

/** The origin stamped on those runs, so the console groups them under diagnostics. */
export const DIAGNOSTICS_LISTENER_ORIGIN = '@adonis-agora/diagnostics';

/** The prefix of every delivery run id: `diag:<event id>:<listener id>`. */
export const DIAGNOSTICS_RUN_PREFIX = 'diag:';

/** The error code `ctx.invoke` rejects with when this process has no listener with that id. */
const UNKNOWN_LISTENER = 'E_UNKNOWN_DIAGNOSTICS_LISTENER';

/**
 * The retry policy a listener gets when `transports.durable()` sets none: three attempts, one
 * second apart and doubling, at most 30 seconds.
 */
export const DIAGNOSTICS_DEFAULT_RETRY: Readonly<StepOptions> = Object.freeze({
  retries: 3,
  backoff: 'exp',
  backoffMs: 1_000,
  backoffMaxMs: 30_000,
});

/** The input of a delivery run: which listener, and the event it receives. */
export interface DiagnosticsListenerInput {
  listenerId: string;
  envelope: DeliveredEvent;
}

/** The run id of one delivery. The same event and listener always give the same id. */
export function diagnosticsRunId(eventId: string, listenerId: string): string {
  return `${DIAGNOSTICS_RUN_PREFIX}${eventId}:${listenerId}`;
}

/** The tags a delivery run carries, so the console can filter by lib, event or listener. */
export function diagnosticsRunTags(delivery: ListenerDelivery): string[] {
  return [
    'diagnostics',
    `lib:${delivery.envelope.lib}`,
    `event:${delivery.envelope.event}`,
    `listener:${delivery.listenerId}`,
  ];
}

/**
 * Whether an engine event belongs to a delivery run. Durable does not forward those runs' own
 * lifecycle events to the diagnostics bus: a listener on `durable` events would otherwise start a
 * delivery run for every delivery run it caused, without end.
 */
export function isDiagnosticsDeliveryEvent(event: {
  runId?: string | undefined;
  workflow?: string | undefined;
}): boolean {
  if (event.workflow !== undefined) return event.workflow === DIAGNOSTICS_LISTENER_WORKFLOW;
  return typeof event.runId === 'string' && event.runId.startsWith(DIAGNOSTICS_RUN_PREFIX);
}

/** Validate `transports.durable(options)` and merge it over {@link DIAGNOSTICS_DEFAULT_RETRY}. */
export function diagnosticsStepOptions(config: DurableTransportConfig = {}): StepOptions {
  const options: StepOptions = { ...DIAGNOSTICS_DEFAULT_RETRY };
  if (config.retries !== undefined) {
    if (!Number.isInteger(config.retries) || config.retries < 1) {
      throw new Error(
        `@adonis-agora/durable: transports.durable({ retries }) must be an integer of at least 1 (got ${String(config.retries)})`,
      );
    }
    options.retries = config.retries;
  }
  for (const key of ['backoffMs', 'backoffMaxMs'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `@adonis-agora/durable: transports.durable({ ${key} }) must be a number of milliseconds of at least 0 (got ${String(value)})`,
      );
    }
    options[key] = value;
  }
  if (config.backoff !== undefined) {
    if (config.backoff !== 'fixed' && config.backoff !== 'exp') {
      throw new Error(
        `@adonis-agora/durable: transports.durable({ backoff }) must be 'fixed' or 'exp' (got ${String(config.backoff)})`,
      );
    }
    options.backoff = config.backoff;
  }
  if (config.jitter !== undefined) options.jitter = config.jitter === true;
  return options;
}

/** The delivery transports alive per engine, stopped by the durable provider before it drains. */
const liveTransports = new WeakMap<WorkflowEngine, Set<DurableDeliveryTransport>>();

/**
 * Stop every diagnostics delivery transport created on `engine`: each one stops taking deliveries
 * and waits for the runs it is creating. The durable provider calls it on shutdown before it drains
 * the engine, whichever of the two providers shuts down first.
 */
export async function stopDiagnosticsDeliveries(engine: WorkflowEngine): Promise<void> {
  const transports = liveTransports.get(engine);
  if (!transports) return;
  await Promise.all([...transports].map((transport) => transport.stop()));
}

/**
 * The {@link ListenerDeliveryTransport} behind `transports.durable()`: each `(listener, event)` is a
 * run of {@link DIAGNOSTICS_LISTENER_WORKFLOW}, which calls the listener inside the `handle` step.
 */
export class DurableDeliveryTransport implements ListenerDeliveryTransport {
  readonly #engine: WorkflowEngine;
  readonly #inFlight = new Set<Promise<void>>();
  #stopped = false;

  constructor(engine: WorkflowEngine) {
    this.#engine = engine;
    let transports = liveTransports.get(engine);
    if (!transports) {
      transports = new Set();
      liveTransports.set(engine, transports);
    }
    transports.add(this);
  }

  /**
   * Start one run per delivery and resolve once every run is stored. A delivery whose run already
   * exists (the same event handed over twice) counts as delivered. When some starts fail, the others
   * still go through and the returned promise rejects with the failures.
   */
  deliver(deliveries: readonly ListenerDelivery[]): Promise<void> {
    if (this.#stopped) {
      return Promise.reject(
        new Error('@adonis-agora/durable: the diagnostics delivery transport is stopped'),
      );
    }
    const work = this.#startAll(deliveries);
    this.#inFlight.add(work);
    const forget = () => this.#inFlight.delete(work);
    work.then(forget, forget);
    return work;
  }

  async #startAll(deliveries: readonly ListenerDelivery[]): Promise<void> {
    const results = await Promise.allSettled(deliveries.map((d) => this.#start(d)));
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `@adonis-agora/durable: ${errors.length} of ${deliveries.length} diagnostics deliveries could not be started`,
      );
    }
  }

  async #start(delivery: ListenerDelivery): Promise<void> {
    const input: DiagnosticsListenerInput = {
      listenerId: delivery.listenerId,
      envelope: delivery.envelope,
    };
    try {
      await this.#engine.start(
        DIAGNOSTICS_LISTENER_WORKFLOW,
        input,
        diagnosticsRunId(delivery.envelope.id, delivery.listenerId),
        { tags: diagnosticsRunTags(delivery), origin: DIAGNOSTICS_LISTENER_ORIGIN },
      );
    } catch (error) {
      // `start` already reports a duplicate id as the existing run; a store that still throws it
      // means the same thing: this delivery is already a run.
      if (error instanceof RunAlreadyExistsError) return;
      throw error;
    }
  }

  /** Stop taking deliveries and wait for the runs being created. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#inFlight]);
    liveTransports.get(this.#engine)?.delete(this);
  }
}

/**
 * Register {@link DIAGNOSTICS_LISTENER_WORKFLOW} on `engine`. Its run calls the listener through
 * `invoke` in a `handle` step with the given retry policy. A listener this process does not know is
 * a {@link FatalError}: retrying cannot make it appear.
 */
export function registerDiagnosticsListenerWorkflow(
  engine: WorkflowEngine,
  invoke: DeliveryTransportContext['invoke'],
  stepOptions: StepOptions,
): void {
  engine.register(
    DIAGNOSTICS_LISTENER_WORKFLOW,
    '1',
    async (ctx: WorkflowCtx, raw: unknown) => {
      const { listenerId, envelope } = raw as DiagnosticsListenerInput;
      await ctx.localStep(
        'handle',
        async () => {
          try {
            await invoke(listenerId, envelope);
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === UNKNOWN_LISTENER) {
              throw new FatalError(
                error instanceof Error
                  ? error.message
                  : `unknown diagnostics listener ${listenerId}`,
                UNKNOWN_LISTENER,
                { listenerId },
              );
            }
            throw error;
          }
          return null;
        },
        stepOptions,
      );
    },
    { tags: ['diagnostics'], origin: DIAGNOSTICS_LISTENER_ORIGIN },
  );
}

/** Whether a durable engine is bound in `app`'s container. */
export function isConfigured(app: ApplicationService): boolean {
  const container = app.container as { hasBinding?: (binding: unknown) => boolean };
  return typeof container.hasBinding === 'function' && container.hasBinding(WorkflowEngine);
}

/**
 * Create the delivery transport for this process: register the listener workflow on the app's
 * engine, so this process can run deliveries, and return the transport that starts them.
 */
export async function createDeliveryTransport(
  context: DeliveryTransportContext,
  config: DurableTransportConfig = {},
): Promise<DurableDeliveryTransport> {
  const stepOptions = diagnosticsStepOptions(config);
  const engine = await context.app.container.make(WorkflowEngine);
  registerDiagnosticsListenerWorkflow(engine, context.invoke, stepOptions);
  return new DurableDeliveryTransport(engine);
}

import { randomUUID } from 'node:crypto';
import { countRuns } from '../concurrency.js';
import type { ControlPlaneContext, ControlPlaneFactory } from '../control-planes/factory.js';
import type {
  ConsoleCommand,
  ControlMessage,
  ControlPlane,
  EngineEvent,
  RunQuery,
  StateStore,
} from '../interfaces.js';
import { loadFanMembers, loadRunDetail, type RunDetailSource } from '../run-detail-summary.js';
import { scanRunValueFacets } from '../run-value-facets.js';
import { listSignalWaitersOfRuns } from '../run-waiting.js';
import { runChildrenFromStore, withoutBookkeepingRuns } from '../store-reads.js';
import type { StoreContext, StoreFactory } from '../stores/factory.js';
import type { DashboardEngine } from './handlers.js';

/**
 * The federated console: one app's durable console also shows the runs of other apps, each of which
 * keeps its own store and runs its own engine. The console reads an app's runs straight from that
 * app's store and sends every action (cancel, retry, signal, schedule control, worker health…) to
 * that app's engine over its control plane, so the app that owns a run is the only one that ever
 * executes anything on it.
 */

/** One other app shown in this console (`config/durable_dashboard.ts` → `apps`). */
export interface FederatedConsoleApp {
  /** The name shown in the app selector. Defaults to the app's key. */
  label?: string | undefined;
  /**
   * That app's state store: `stores.lucid({ connection, schema })` naming where ITS durable tables
   * are. Only read: give the connection's role `SELECT` on them and nothing else.
   */
  store: StoreFactory | StateStore;
  /**
   * That app's control plane: `controlPlanes.redis({ connection, prefix })` with the prefix THAT app
   * uses. Carries the actions (the app must set `consoleCommands: true` in its `config/durable.ts`)
   * and the live tail of its runs.
   */
  controlPlane: ControlPlaneFactory | ControlPlane;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/**
 * The console verbs another app's console may ask this app's engine to run. Reads that need nothing
 * but the store are not here: the federated console reads the store itself.
 */
export const CONSOLE_COMMAND_VERBS = [
  'requeue',
  'redispatchPending',
  'cancel',
  'retryWithInput',
  'continue',
  'signal',
  'update',
  'completeTask',
  'failTask',
  'listSchedules',
  'setSchedulePaused',
  'triggerSchedule',
  'workerHealth',
  'republishLifecycle',
  'workflowLifecycle',
  'getEvent',
] as const satisfies ReadonlyArray<keyof DashboardEngine>;

export type ConsoleCommandVerb = (typeof CONSOLE_COMMAND_VERBS)[number];

/** The verbs that only read (not written to the owning app's log). */
const READ_VERBS: ReadonlySet<string> = new Set<ConsoleCommandVerb>([
  'listSchedules',
  'workerHealth',
  'workflowLifecycle',
  'getEvent',
]);

const KNOWN_VERBS: ReadonlySet<string> = new Set<string>(CONSOLE_COMMAND_VERBS);

/** The code of an error an action gets when the owning app could not be reached. */
export const FEDERATED_APP_UNREACHABLE = 'federated-app-unreachable';

/** An action the owning app did not answer, or answered with an error of its own. */
export class FederatedAppError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FederatedAppError';
    this.code = code;
  }
}

/**
 * Run the console commands other apps' consoles send this app, on `controlPlane`, against this app's
 * read/control port. Returns `false` when the control plane cannot carry them; throws when it can
 * but refuses to (the Redis control plane without an atomic claim), so no command runs unclaimed.
 */
export function answerConsoleCommands(
  controlPlane: ControlPlane,
  engine: DashboardEngine,
  log?: (line: string) => void,
): boolean {
  if (typeof controlPlane.onConsoleCommand !== 'function') return false;
  controlPlane.onConsoleCommand(async (command: ConsoleCommand) => {
    const fn = KNOWN_VERBS.has(command.verb)
      ? (engine as unknown as Record<string, unknown>)[command.verb]
      : undefined;
    if (typeof fn !== 'function') {
      throw new FederatedAppError(
        `this app does not answer the console command ${command.verb}`,
        'unsupported-request',
      );
    }
    if (log && !READ_VERBS.has(command.verb)) {
      const target = typeof command.args[0] === 'string' ? ` ${command.args[0]}` : '';
      log(`[durable] federated console: ${command.verb}${target} by ${command.actor ?? 'unknown'}`);
    }
    return (fn as (...args: unknown[]) => unknown).apply(engine, command.args);
  });
  return true;
}

/**
 * Another app as the console sees it: its store, its control plane, and the live-tail listeners of
 * the runs this console streams. Build it once per app ({@link buildFederatedApp}); {@link engine}
 * is cheap and made per request.
 */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly #store: StateStore;
  readonly #controlPlane: ControlPlane;
  readonly #timeoutMs: number | undefined;
  readonly #listeners = new Map<string, Set<(event: EngineEvent) => void>>();
  #listening = false;

  constructor(options: {
    id: string;
    label?: string | undefined;
    store: StateStore;
    controlPlane: ControlPlane;
    timeoutMs?: number | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.#store = options.store;
    this.#controlPlane = options.controlPlane;
    this.#timeoutMs = options.timeoutMs;
  }

  /** The console's read/control port over this app. `actor` names who acts, for the app's log. */
  engine(actor?: string): DashboardEngine {
    const store = this.#store;
    const remote =
      <A extends unknown[], R>(verb: ConsoleCommandVerb) =>
      (...args: A): Promise<R> =>
        this.#send(verb, args, actor) as Promise<R>;
    const source: RunDetailSource = {
      getRun: (id) => store.getRun(id),
      listCheckpoints: (id) => store.listCheckpoints(id),
      getRunChildren: (id) => runChildrenFromStore(store, id),
      ...(store.checkpointStats && store.queryCheckpoints
        ? {
            checkpointStats: store.checkpointStats.bind(store),
            queryCheckpoints: store.queryCheckpoints.bind(store),
          }
        : {}),
    };
    return {
      // Reads: the app's store, as its own engine reads it.
      getRun: (runId) => store.getRun(runId),
      // The store honors `excludeWorkflows` itself, for the list and the count alike.
      listRuns: (query) => store.listRuns(withoutBookkeepingRuns(query)),
      listCheckpoints: (runId) => store.listCheckpoints(runId),
      getRunChildren: (runId) => runChildrenFromStore(store, runId),
      getRunDetail: (runId, options) => loadRunDetail(source, runId, options),
      getFanMembers: (runId, group, query) => loadFanMembers(source, runId, group, query),
      countRuns: (query: Omit<RunQuery, 'page' | 'size'>) =>
        countRuns(store, withoutBookkeepingRuns(query)),
      runValueFacets: (axis, query, opts) => {
        const scoped = withoutBookkeepingRuns(query);
        return store.runValueFacets
          ? store.runValueFacets(axis, scoped, opts)
          : scanRunValueFacets(store, axis, scoped, opts);
      },
      listSignalWaiters: (prefix) => store.listSignalWaiters(prefix),
      listSignalWaitersByRunIds: (runIds) => listSignalWaitersOfRuns(store, runIds),
      // Actions, and what only the app's engine knows: its engine, over its control plane.
      requeue: remote('requeue'),
      redispatchPending: remote('redispatchPending'),
      cancel: remote('cancel'),
      retryWithInput: remote('retryWithInput'),
      continue: remote('continue'),
      signal: remote('signal'),
      update: remote('update'),
      completeTask: remote('completeTask'),
      failTask: remote('failTask'),
      listSchedules: remote('listSchedules'),
      setSchedulePaused: remote('setSchedulePaused'),
      triggerSchedule: remote('triggerSchedule'),
      workerHealth: remote('workerHealth'),
      republishLifecycle: remote('republishLifecycle'),
      workflowLifecycle: remote('workflowLifecycle'),
      getEvent: remote('getEvent'),
      subscribe: (runId, onEvent) => this.#subscribe(runId, onEvent),
    };
  }

  async #send(verb: ConsoleCommandVerb, args: unknown[], actor: string | undefined) {
    const send = this.#controlPlane.sendConsoleCommand?.bind(this.#controlPlane);
    if (!send) {
      throw new FederatedAppError(
        `the control plane of the "${this.id}" app cannot carry console commands`,
        FEDERATED_APP_UNREACHABLE,
      );
    }
    // A trailing `undefined` (an omitted optional argument) is not sent.
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    let reply: Awaited<ReturnType<typeof send>>;
    try {
      reply = await send(
        { id: randomUUID(), verb, args, ...(actor !== undefined ? { actor } : {}) },
        this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {},
      );
    } catch (err) {
      throw new FederatedAppError(
        err instanceof Error ? err.message : String(err),
        FEDERATED_APP_UNREACHABLE,
      );
    }
    if (!reply.ok) throw new FederatedAppError(reply.error.message, reply.error.code);
    return reply.data;
  }

  /** Live events of one of the app's runs, from the app's control plane. */
  #subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    if (!this.#listening) {
      this.#listening = true;
      // Every namespace of the app, like the app's own console.
      this.#controlPlane.observeAll?.();
      this.#controlPlane.onControl((msg: ControlMessage) => {
        const events = msg.kind === 'event' ? [msg.event] : msg.kind === 'events' ? msg.events : [];
        for (const event of events) {
          const listeners = this.#listeners.get(event.runId);
          if (!listeners) continue;
          // `at` is a string after the JSON trip.
          const normalized = { ...event, at: new Date(event.at) };
          for (const listener of listeners) {
            try {
              listener(normalized);
            } catch {
              /* a listener must not break the others */
            }
          }
        }
      });
    }
    let set = this.#listeners.get(runId);
    if (!set) {
      set = new Set();
      this.#listeners.set(runId, set);
    }
    set.add(onEvent);
    return () => {
      const current = this.#listeners.get(runId);
      current?.delete(onEvent);
      if (current?.size === 0) this.#listeners.delete(runId);
    };
  }

  /** Close the app's control plane (the console's process is shutting down). */
  async close(): Promise<void> {
    this.#listeners.clear();
    await (this.#controlPlane as { close?: () => Promise<void> }).close?.();
  }
}

/** Build one configured app: its store and control plane (factories are called once, here). */
export async function buildFederatedApp(
  id: string,
  config: FederatedConsoleApp,
  ctx: StoreContext & ControlPlaneContext,
): Promise<FederatedApp> {
  const store = typeof config.store === 'function' ? await config.store(ctx) : config.store;
  const controlPlane =
    typeof config.controlPlane === 'function'
      ? await config.controlPlane(ctx)
      : config.controlPlane;
  return new FederatedApp({
    id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    store,
    controlPlane,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
}

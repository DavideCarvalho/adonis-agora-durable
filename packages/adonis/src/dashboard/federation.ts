import { randomUUID } from 'node:crypto';
import { appKeyOf } from '../app_key.js';
import { countRuns } from '../concurrency.js';
import {
  ConsoleChannelError,
  type ConsoleCommandAuthOptions,
  type ConsoleSideOptions,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../control-plane-redis/console-auth.js';
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
import { appScopedDashboardEngine } from './app_scope.js';
import { type ConsoleCapabilityTable, consoleCapabilityAllows } from './console_capabilities.js';
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
   * uses. Carries the actions (the app sets `consoleCommands` in its `config/durable.ts`) and the
   * live tail of its runs. How the console authenticates its actions there goes here too
   * (`secret`, `token`, `publicKey`, `crypto`, `partition`: {@link ConsoleSideOptions}); nothing to
   * set with `@adonis-agora/crypto` booted in this app.
   */
  controlPlane: ControlPlaneFactory | ControlPlane;
  /**
   * `false`: browse-only. The console reads that app's store but sends it no action (cancel,
   * retry, signal, schedule control…), and needs no authentication for it. Without authentication
   * an entry must say so, or the console refuses to boot. Default: actions are sent (the app decides,
   * with its own `consoleCommands.actions`).
   */
  actions?: boolean | undefined;
  /** How long an action waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/**
 * The capabilities a console's token (token mode) may hold for an app, `urn:agora:durable`. `durable:*`
 * holds them all.
 */
export const DURABLE_CONSOLE_CAPABILITIES = {
  /** Read what only the app's engine knows: schedules, worker health, lifecycle links, events. */
  read: 'durable:read',
  /** Act on runs: cancel, requeue, retry (with new input), continue, signal, update, republish. */
  runsWrite: 'durable:runs:write',
  /** Complete or fail a run's external (human) tasks. */
  tasksWrite: 'durable:tasks:write',
  /** Pause, resume and trigger schedules. */
  schedulesWrite: 'durable:schedules:write',
  /** Every read verb (the Agora-wide name, like `durable:read`). */
  consoleRead: 'durable:console:read',
  /** Every write verb (the Agora-wide name: runs, tasks and schedules at once). */
  consoleWrite: 'durable:console:write',
} as const;

/**
 * What the console sends when its `authorize` does not narrow the viewer's capabilities: every verb.
 * `durable:console:*`, `durable:*` or `*` grant the same.
 */
export const DURABLE_CONSOLE_FULL_CAPABILITIES: readonly string[] = [
  DURABLE_CONSOLE_CAPABILITIES.read,
  DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  DURABLE_CONSOLE_CAPABILITIES.tasksWrite,
  DURABLE_CONSOLE_CAPABILITIES.schedulesWrite,
];

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

/** Whether `verb` only reads (it is answered even with `consoleCommands.actions` off). */
export function isConsoleReadVerb(verb: string): boolean {
  return READ_VERBS.has(verb);
}

/** The capability a console's token needs for each verb (token mode). */
export const CONSOLE_VERB_CAPABILITY: Readonly<Record<ConsoleCommandVerb, string>> = {
  requeue: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  redispatchPending: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  cancel: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  retryWithInput: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  continue: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  signal: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  update: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  republishLifecycle: DURABLE_CONSOLE_CAPABILITIES.runsWrite,
  completeTask: DURABLE_CONSOLE_CAPABILITIES.tasksWrite,
  failTask: DURABLE_CONSOLE_CAPABILITIES.tasksWrite,
  setSchedulePaused: DURABLE_CONSOLE_CAPABILITIES.schedulesWrite,
  triggerSchedule: DURABLE_CONSOLE_CAPABILITIES.schedulesWrite,
  listSchedules: DURABLE_CONSOLE_CAPABILITIES.read,
  workerHealth: DURABLE_CONSOLE_CAPABILITIES.read,
  workflowLifecycle: DURABLE_CONSOLE_CAPABILITIES.read,
  getEvent: DURABLE_CONSOLE_CAPABILITIES.read,
};

/** Durable's console capabilities, each a read or a write (the canonical matcher's table). */
export const DURABLE_CONSOLE_CAPABILITY_TABLE: ConsoleCapabilityTable = {
  [DURABLE_CONSOLE_CAPABILITIES.read]: 'read',
  [DURABLE_CONSOLE_CAPABILITIES.runsWrite]: 'write',
  [DURABLE_CONSOLE_CAPABILITIES.tasksWrite]: 'write',
  [DURABLE_CONSOLE_CAPABILITIES.schedulesWrite]: 'write',
};

/** Whether `granted` allows `capability`, by the one console matcher (`console_capabilities.ts`). */
export function durableConsoleAllows(granted: readonly unknown[], capability: string): boolean {
  return consoleCapabilityAllows(granted, capability, DURABLE_CONSOLE_CAPABILITY_TABLE);
}

/**
 * Whether `granted` (a token's or a viewer's capabilities) allows `verb`: its capability
 * ({@link CONSOLE_VERB_CAPABILITY}) by the canonical console matcher — exact, `*`, `durable:*`,
 * `durable:console:*`, `durable:console:write` (writes and reads), `durable:console:read` (reads),
 * or a `durable:` grant whose only `*` is its last segment. No other `*` grants anything.
 */
export function consoleVerbAllowed(granted: readonly string[], verb: ConsoleCommandVerb): boolean {
  return durableConsoleAllows(granted, CONSOLE_VERB_CAPABILITY[verb]);
}

/** Every capability name durable's console checks (the finer names and the Agora-wide groups). */
const CONSOLE_CAPABILITY_NAMES: readonly string[] = [
  ...DURABLE_CONSOLE_FULL_CAPABILITIES,
  DURABLE_CONSOLE_CAPABILITIES.consoleRead,
  DURABLE_CONSOLE_CAPABILITIES.consoleWrite,
];

/**
 * The capabilities a viewer has in durable's console, from its `authorize`: the ones that reach
 * durable's console set (another lib's are dropped), or the full set when `authorize` names none.
 * `access: 'read'` keeps reads only.
 */
export function viewerConsoleCapabilities(
  capabilities: readonly string[] | undefined,
  access?: 'read' | 'write' | undefined,
): string[] {
  const granted =
    capabilities === undefined
      ? [...DURABLE_CONSOLE_FULL_CAPABILITIES]
      : capabilities.filter((c) =>
          CONSOLE_CAPABILITY_NAMES.some((name) => durableConsoleAllows([c], name)),
        );
  if (access !== 'read') return granted;
  return consoleVerbAllowed(granted, 'workerHealth') ? [DURABLE_CONSOLE_CAPABILITIES.read] : [];
}

/**
 * `engine` with every action the viewer's `capabilities` do not allow refused (`403`, "the viewer
 * lacks …"): the console's own app, narrowed like the commands it sends to another one.
 */
export function viewerScopedDashboardEngine(
  engine: DashboardEngine,
  capabilities: readonly string[],
): DashboardEngine {
  const refused = new Map<string, () => Promise<never>>();
  for (const verb of CONSOLE_COMMAND_VERBS) {
    if (READ_VERBS.has(verb) || consoleVerbAllowed(capabilities, verb)) continue;
    refused.set(verb, async () => {
      throw forbidden(`the viewer lacks ${CONSOLE_VERB_CAPABILITY[verb]}`);
    });
  }
  if (refused.size === 0) return engine;
  // A proxy, so an engine whose methods live on its prototype keeps them (bound to itself).
  return new Proxy(engine, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property === 'string' && refused.has(property) && typeof value === 'function') {
        return refused.get(property);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The code of an error an action gets when the owning app could not be reached. */
export const FEDERATED_APP_UNREACHABLE = 'federated-app-unreachable';

/** An action the owning app did not answer, or answered with an error of its own. */
export class FederatedAppError extends Error {
  readonly code: string | undefined;
  /** The HTTP status the owning app gave the refusal (`401` for a refused token, `403`), when any. */
  readonly status: number | undefined;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'FederatedAppError';
    this.code = code;
    this.status = status;
  }
}

/** The code of an action the owning app refused (the token's app or capabilities do not allow it). */
export const FEDERATED_FORBIDDEN = 'forbidden';

/** The code of a command that came without the viewer's capabilities (refused, `403`). */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

const PACKAGE = '@adonis-agora/durable';

/** What the owning app lets the federated console do, besides authenticating it. */
export interface AnswerConsoleCommandsOptions {
  /**
   * How commands are authenticated (`consoleCommands.secret` / `.verifyTenant` + `appKey` /
   * `.crypto`). Without one, the Redis control plane answers no command at all.
   */
  auth?: ConsoleCommandAuthOptions | undefined;
  /**
   * This app's partition (`consoleCommands.partition`, else its crypto partition or namespace): a
   * classic tenant token must be for it — or, on a control plane, for one of its tenant apps.
   */
  partition?: string | undefined;
  /**
   * With {@link confineRuns}: the apps (namespaces) whose runs, schedules and worker groups a command
   * may touch, and the tenant apps whose own tokens are taken (each confined to its app's runs).
   * `'*'`: every app. Default: the control plane's own runs only ({@link ownNamespace}).
   */
  apps?: '*' | readonly string[] | undefined;
  /** With {@link confineRuns} and no {@link apps}: this app's own namespace. Default `'default'`. */
  ownNamespace?: string | undefined;
  /**
   * Whether this app's runs belong to several apps (a control plane: an app's runs are in its
   * partition's namespace). Then commands are confined to {@link apps} (and a tenant token to its
   * app). Default `false`: every run here is this app's.
   */
  confineRuns?: boolean | undefined;
  /**
   * Whether the console may act (cancel, retry, signal, complete a task, pause or trigger a
   * schedule…). Reads (schedules, worker health, lifecycle links, events) are answered either way.
   * Default `false`: every action answers `403` until the app opts in (`consoleCommands.actions`).
   */
  actions?: boolean | undefined;
  /** Hears a command refused before it ran (unsigned, forged, stale, tampered). */
  onError?: ((error: unknown) => void) | undefined;
}

function forbidden(message: string, code: string = FEDERATED_FORBIDDEN): FederatedAppError {
  return new FederatedAppError(`[${PACKAGE}] ${message}`, code, 403);
}

/**
 * Run the console commands other apps' consoles send this app, on `controlPlane`, against this app's
 * read/control port. Returns `false` when the control plane cannot carry them; throws when it can
 * but refuses to (no `auth`, or the Redis control plane without an atomic claim), so no command runs
 * unauthenticated or unclaimed.
 *
 * Every command carries the capabilities of the console's viewer, and one without them is refused
 * (`capabilities-required`): they must allow the verb ({@link consoleVerbAllowed}). A token, when
 * the command carries one, must allow it too: an authkit app-call token is bound to this app by its
 * audience; a classic tenant token must be for this app's {@link AnswerConsoleCommandsOptions.partition}
 * (or, on a control plane, for one of its tenant apps, and is then confined to that app's runs). An
 * action (anything but a read) also needs {@link AnswerConsoleCommandsOptions.actions}.
 */
export function answerConsoleCommands(
  controlPlane: ControlPlane,
  engine: DashboardEngine,
  log?: (line: string) => void,
  options: AnswerConsoleCommandsOptions = {},
): boolean {
  if (typeof controlPlane.onConsoleCommand !== 'function') return false;
  const confineRuns = options.confineRuns === true;
  // The apps listed explicitly (`'*'`: every one). Without a list, a control plane's commands touch
  // its own runs only (its namespace): acting across tenants takes an explicit list.
  const listedApps =
    options.apps === undefined || options.apps === '*' ? undefined : [...options.apps];
  const apps: '*' | string[] =
    options.apps === '*'
      ? '*'
      : (listedApps ?? (confineRuns ? [options.ownNamespace ?? 'default'] : '*'));
  const actions = options.actions === true;
  const own = options.partition;
  // The port each command runs against: every run here, or the runs of the apps it may touch.
  const scoped = (forApps: '*' | string[]): DashboardEngine =>
    !confineRuns || forApps === '*' ? engine : appScopedDashboardEngine(engine, forApps);
  const untokened = scoped(apps);
  controlPlane.onConsoleCommand(
    async (command: ConsoleCommand) => {
      if (!KNOWN_VERBS.has(command.verb)) {
        throw new FederatedAppError(
          `[${PACKAGE}] this app does not answer the console command ${command.verb}`,
          'unsupported-request',
        );
      }
      const verb = command.verb as ConsoleCommandVerb;
      const required = CONSOLE_VERB_CAPABILITY[verb];
      let target = untokened;
      const verified = command.verified;
      // The viewer's capabilities: always sent by a current console. Missing never means everything.
      if (!Array.isArray(command.capabilities)) {
        const error = forbidden(
          'the console sent no capabilities with this command (update @adonis-agora/durable on the console app)',
          CAPABILITIES_REQUIRED,
        );
        // Answered 403, and logged here like any refused command.
        options.onError?.(error);
        throw error;
      }
      // Order: the token, then the viewer, then the partition and `actions`.
      if (verified && !consoleVerbAllowed(verified.capabilities, verb)) {
        throw forbidden(
          verified.appCall
            ? `the console's token lacks ${required} (the app-call token of "${verified.partition}": grant it in authkit)`
            : `the console's token lacks ${required}`,
        );
      }
      if (!consoleVerbAllowed(command.capabilities, verb)) {
        throw forbidden(`the viewer lacks ${required}`);
      }
      // An app-call token is bound to this app by its audience: no partition rule. A classic tenant
      // token must be for this app; on a control plane, one for a tenant app is taken only when
      // `consoleCommands.apps` lists that app, and is then confined to its runs.
      if (verified && !verified.appCall && verified.partition !== own) {
        if (!(confineRuns && (options.apps === '*' || listedApps?.includes(verified.partition)))) {
          throw forbidden(
            own === undefined
              ? `the console's token is for "${verified.partition}", and this app has no partition to match it (set \`consoleCommands.partition\`)`
              : `the console's token is for "${verified.partition}", not "${own}"${confineRuns ? ' (list it in `consoleCommands.apps` to let it act on that app)' : ''}`,
          );
        }
        target = scoped([verified.partition]);
      }
      if (!actions && !READ_VERBS.has(verb)) {
        throw forbidden(
          `this app takes no action from the console (${verb}); set \`consoleCommands.actions: true\` in its config/durable.ts`,
        );
      }
      const fn = (target as unknown as Record<string, unknown>)[verb];
      if (typeof fn !== 'function') {
        throw new FederatedAppError(
          `[${PACKAGE}] this app does not answer the console command ${command.verb}`,
          'unsupported-request',
        );
      }
      if (log && !READ_VERBS.has(verb)) {
        const runTarget = typeof command.args[0] === 'string' ? ` ${command.args[0]}` : '';
        const who = command.actor ?? 'unknown';
        const via = verified?.appCall
          ? ` (app-call token of ${verified.partition})`
          : verified
            ? ` (token for ${verified.partition})`
            : '';
        log(`[${PACKAGE}] federated console: ${verb}${runTarget} by ${who}${via}`);
      }
      return (fn as (...args: unknown[]) => unknown).apply(target, command.args);
    },
    {
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    },
  );
  return true;
}

/** The authentication a configured app's console side uses, or `undefined` when it has none. */
export function federatedAppAuth(
  config: FederatedConsoleApp,
): ConsoleCommandAuthOptions | undefined {
  const side = federatedConsoleSide(config);
  const crypto = side.crypto === false ? undefined : side.crypto;
  const token = side.token === false ? undefined : side.token;
  if (side.secret === undefined && token === undefined && crypto === undefined) {
    return undefined;
  }
  return {
    ...(side.secret !== undefined ? { secret: side.secret } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(side.publicKey !== undefined ? { publicKey: side.publicKey } : {}),
    ...(crypto !== undefined ? { crypto } : {}),
  };
}

/**
 * How the console authenticates to a configured app: the options of its `controlPlane`
 * (`controlPlanes.redis({ ..., secret })`, or a built `RedisControlPlane`'s `console`).
 */
export function federatedConsoleSide(config: FederatedConsoleApp): ConsoleSideOptions {
  const side = (config.controlPlane as { console?: unknown }).console;
  return side && typeof side === 'object' ? (side as ConsoleSideOptions) : {};
}

/** A configured app as the console-side resolution reads it: its control plane's options and `actions`. */
export function federatedConsoleEntry(
  config: FederatedConsoleApp,
): ConsoleSideOptions & { actions?: boolean | undefined } {
  return {
    ...federatedConsoleSide(config),
    ...(config.actions !== undefined ? { actions: config.actions } : {}),
  };
}

/** The partition of a configured app on the crypto server: its `partition`, else its key. */
export function federatedAppPartition(id: string, config: FederatedConsoleApp): string {
  const partition = federatedConsoleSide(config).partition;
  return typeof partition === 'string' && partition !== '' ? partition : id;
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
  readonly #auth: ConsoleCommandAuthOptions | undefined;
  readonly #actions: boolean;
  readonly #listeners = new Map<string, Set<(event: EngineEvent) => void>>();
  #listening = false;

  constructor(options: {
    id: string;
    label?: string | undefined;
    store: StateStore;
    controlPlane: ControlPlane;
    timeoutMs?: number | undefined;
    /** How this console authenticates its commands to the app (see {@link federatedAppAuth}). */
    auth?: ConsoleCommandAuthOptions | undefined;
    /** `false`: browse-only, no action is sent (reads still are, when there is `auth`). */
    actions?: boolean | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.#store = options.store;
    this.#controlPlane = options.controlPlane;
    this.#timeoutMs = options.timeoutMs;
    this.#auth = options.auth;
    this.#actions = options.actions !== false;
  }

  /**
   * The console's read/control port over this app. `actor` names who acts, for the app's log;
   * `capabilities` are what that viewer may do there (the console's `authorize`), sent with every
   * command — the full console set when not given.
   */
  engine(actor?: string, capabilities?: readonly string[]): DashboardEngine {
    const store = this.#store;
    const granted = [...(capabilities ?? DURABLE_CONSOLE_FULL_CAPABILITIES)];
    const remote =
      <A extends unknown[], R>(verb: ConsoleCommandVerb) =>
      (...args: A): Promise<R> =>
        this.#send(verb, args, actor, granted) as Promise<R>;
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

  async #send(
    verb: ConsoleCommandVerb,
    args: unknown[],
    actor: string | undefined,
    capabilities: string[],
  ) {
    if (!this.#actions && !READ_VERBS.has(verb)) {
      throw forbidden(
        `the "${this.id}" app is browse-only in this console (apps.${this.id}.actions is false)`,
      );
    }
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
        { id: randomUUID(), verb, args, capabilities, ...(actor !== undefined ? { actor } : {}) },
        {
          ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
          ...(this.#auth !== undefined ? { auth: this.#auth } : {}),
          app: this.id,
        },
      );
    } catch (err) {
      throw new FederatedAppError(
        err instanceof Error ? err.message : String(err),
        // A control plane with no authentication says so; anything else is the app not answering.
        err instanceof ConsoleChannelError && err.code === UNSIGNED_CHANNEL
          ? UNSIGNED_CHANNEL
          : FEDERATED_APP_UNREACHABLE,
      );
    }
    if (!reply.ok) {
      throw new FederatedAppError(reply.error.message, reply.error.code, reply.error.status);
    }
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

/**
 * Who runs actions on a configured app's runs from this console, as `GET /apps` reports it: `'app'`
 * (the console sends them to that app over its control plane) or `'none'` when the console has no
 * way to authenticate them (no `secret`, `token` or `crypto`) or the control plane given is a built
 * one that cannot carry console commands (the console only browses that app). A factory is not built
 * just to answer this: the factories this package ships carry them.
 */
export function federatedAppActions(
  config: FederatedConsoleApp,
  auth: ConsoleCommandAuthOptions | undefined = federatedAppAuth(config),
): 'app' | 'none' {
  if (config.actions === false || auth === undefined) return 'none';
  const plane = config.controlPlane;
  if (typeof plane === 'function') return 'app';
  return typeof plane.sendConsoleCommand === 'function' ? 'app' : 'none';
}

/** Build one configured app: its store and control plane (factories are called once, here). */
export async function buildFederatedApp(
  id: string,
  config: FederatedConsoleApp,
  ctx: StoreContext & ControlPlaneContext,
  /** The authentication resolved at boot (automatic modes included); default: the explicit one. */
  resolvedAuth: ConsoleCommandAuthOptions | undefined = federatedAppAuth(config),
): Promise<FederatedApp> {
  const store = typeof config.store === 'function' ? await config.store(ctx) : config.store;
  const controlPlane =
    typeof config.controlPlane === 'function'
      ? await config.controlPlane(ctx)
      : config.controlPlane;
  const auth = resolvedAuth;
  return new FederatedApp({
    id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    store,
    controlPlane,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(auth ? { auth } : {}),
    ...(config.actions === false ? { actions: false } : {}),
  });
}

export { UNAUTHORIZED_CONSOLE, UNSIGNED_CHANNEL };

/**
 * This app's key (see {@link appKeyOf}: `app.appKey`, else `config/encryption.ts`'s default key,
 * else `APP_KEY`): what token-mode console commands are sealed to (a key pair derived from it).
 */
export function consoleAppKey(app: unknown): Promise<string | { release(): string } | undefined> {
  return appKeyOf(app);
}

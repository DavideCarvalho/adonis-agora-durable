import {
  type BarrelTree,
  barrelModules,
  type DiscoveryModule,
  DuplicateDiscoveryError,
  type RootedBarrel,
  scanDirsModules,
} from './discovery-roots.js';
import type { WorkflowEngine } from './engine.js';
import { eventTriggerCanonicalName, workflowEvents } from './workflow-events.js';
import {
  onErrorRoutesOf,
  type WorkflowMeta,
  workflowMeta,
  workflowSchedules,
} from './workflow-ref.js';

/**
 * The constructor shape discovery hands back. Deliberately **not** {@link WorkflowClass}: that one
 * is `abstract new` so any `BaseWorkflow` subclass can be *referenced* (`ctx.child(Cls)`,
 * `engine.start(Cls)`). Discovery loads real, instantiable classes and
 * {@link registerWorkflowClass} does `new Ctor()` on each one, so typing them as abstract left
 * consumers unable to instantiate what the API gave them. Concrete constructors stay assignable to
 * {@link WorkflowClass}, so every existing reference-style use keeps working.
 */
export type DiscoveredWorkflowClass = new () => {
  run(ctx: unknown, input: unknown): Promise<unknown> | unknown;
};

/** A discovered workflow class plus its resolved {@link WorkflowMeta} — from a `BaseWorkflow`
 *  subclass's `static workflow` config. */
export interface DiscoveredWorkflow {
  meta: WorkflowMeta;
  cls: DiscoveredWorkflowClass;
  /** The module it was found in: an absolute path for a directory scan, the key for a barrel. */
  file: string;
}

/**
 * A factory that instantiates a workflow class. When provided, it replaces the default `new Ctor()` —
 * the AdonisJS provider passes `(Ctor) => app.container.make(Ctor)` so the container resolves the
 * constructor and dependency injection (constructor params) works, like the `@adonisjs/queue` job
 * factory. May return the instance or a Promise (the container's `make` is async). Defaults to
 * `(Ctor) => new Ctor()` for library-level/tests use.
 */
export type WorkflowClassFactory = (
  ctor: DiscoveredWorkflowClass,
) => DiscoveredWorkflowClass['prototype'] | Promise<DiscoveredWorkflowClass['prototype']>;

function defaultWorkflowFactory(
  ctor: DiscoveredWorkflowClass,
): DiscoveredWorkflowClass['prototype'] {
  return new ctor();
}

/**
 * Register a single workflow class on the engine — a `BaseWorkflow` subclass (its `static workflow`
 * config), resolved via {@link workflowMeta}. Instantiates it once and binds its `run(ctx, input)`
 * as the workflow body via `engine.register`. The low-level `engine.register(name, version, fn)`
 * stays the escape hatch — this is the convenience the `app/workflows` convention builds on. No-op
 * (returns `false`) for a non-workflow class (no `static workflow` config).
 *
 * `factory` lets the host resolve the instance via the IoC container (constructor injection); when
 * omitted, the class is instantiated directly with `new Ctor()` (no args). The factory may be async
 * (the Adonis container's `make` resolves async), so this function is async.
 */
export async function registerWorkflowClass(
  engine: WorkflowEngine,
  cls: unknown,
  factory: WorkflowClassFactory = defaultWorkflowFactory,
): Promise<boolean> {
  const meta = workflowMeta(cls);
  if (!meta) return false;
  const Ctor = cls as DiscoveredWorkflowClass;
  const instance = await factory(Ctor);
  // Colocated `static on` event triggers: exact-string ones register under the engine's
  // `onEvent` (the bridge publishes the canonical name); regex/any ones are started
  // directly by the bridge. Both are recorded so the provider can attach the bridge.
  const events = workflowEvents(cls);
  if (events.length > 0) engine.registerEventTriggers(events);
  const exactNames = events
    .map(eventTriggerCanonicalName)
    .filter((name): name is string => name !== null);
  engine.register(
    meta.name,
    meta.version,
    (ctx, input) => Promise.resolve(instance.run(ctx, input)),
    {
      ...(meta.tags ? { tags: meta.tags } : {}),
      ...(meta.executionTimeout !== undefined ? { executionTimeout: meta.executionTimeout } : {}),
      ...(meta.onEvent || exactNames.length > 0
        ? { onEvent: [...(meta.onEvent ?? []), ...exactNames] }
        : {}),
      ...(meta.singleton ? { singleton: meta.singleton } : {}),
      ...(meta.concurrency ? { concurrency: meta.concurrency } : {}),
      ...(meta.origin ? { origin: meta.origin } : {}),
      ...(meta.onError?.length ? { onError: onErrorRoutesOf(meta) } : {}),
      ...(meta.inputSchema ? { inputSchema: meta.inputSchema } : {}),
      ...(meta.searchAttributes ? { searchAttributesSchema: meta.searchAttributes } : {}),
    },
  );
  // Collect any colocated `static schedule` on the class so the worker loop can fire it alongside the
  // config schedules. Both discovery paths (dir scan + generated barrel) funnel through here, so this
  // is the single place that wires colocation.
  const schedules = workflowSchedules(cls);
  if (schedules.length > 0) engine.registerSchedules(schedules);
  return true;
}

/** Re-exported from its shared home so existing `pickModuleExt` imports keep working. */
export { pickModuleExt } from './discovery-roots.js';

/**
 * Collect every workflow class reachable from `modules`, in order: each export is considered
 * (default and named), and a class seen twice (re-exported from several modules, or reachable from
 * two overlapping roots) is kept once.
 *
 * Two DIFFERENT classes claiming the same name + version from two different roots throw a
 * {@link DuplicateDiscoveryError} quoting both files — before anything is registered. Within a single
 * root nothing changes from the single-directory behaviour (both are kept; the later registration
 * wins on the engine).
 */
async function collectWorkflows(
  modules: readonly DiscoveryModule[],
): Promise<DiscoveredWorkflow[]> {
  const found: DiscoveredWorkflow[] = [];
  const seen = new Set<unknown>();
  const owners = new Map<string, { root: string; file: string }>();
  for (const { root, file, load } of modules) {
    const mod = await load();
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const meta = workflowMeta(exported);
      if (!meta) continue;
      const id = `${meta.name}@${meta.version}`;
      const owner = owners.get(id);
      if (owner && owner.root !== root) {
        throw new DuplicateDiscoveryError('workflow', id, [owner.file, file]);
      }
      if (!owner) owners.set(id, { root, file });
      seen.add(exported);
      found.push({ meta, cls: exported as DiscoveredWorkflowClass, file });
    }
  }
  return found;
}

/**
 * Scan one directory — or several — RECURSIVELY for modules and collect every exported workflow
 * class — a `BaseWorkflow` subclass (the default export and any named export are considered) — so
 * nested conventions like `app/workflows/billing/charge_workflow.ts` are found, matching
 * `make:workflow`'s nested-path scaffolding. Only the extension present in each directory is
 * imported (see {@link pickModuleExt}), and each module path is visited once, so a built `.js` and a
 * dev `.ts` of the same module never both register. Missing directory → nothing from it (the
 * convention is opt-in: no `app/workflows`, nothing to register).
 *
 * With several directories (a modular app: `['app/orders/flows', 'app/billing/flows']`) every root
 * is walked in order, and the same workflow name + version defined by different classes in two
 * roots throws a {@link DuplicateDiscoveryError} naming both files.
 */
export async function discoverWorkflows(
  dir: string | readonly string[],
): Promise<DiscoveredWorkflow[]> {
  return collectWorkflows(await scanDirsModules(typeof dir === 'string' ? [dir] : dir));
}

/**
 * Discover every workflow class (`BaseWorkflow` subclass) under `dir` — one directory or several,
 * see {@link discoverWorkflows} — and register each on the engine. Returns the registered metadata
 * so the caller can log what was wired. Best-effort over a missing directory; throws a
 * {@link DuplicateDiscoveryError} (registering nothing) on a cross-directory name clash.
 */
export async function registerWorkflowsFromDir(
  engine: WorkflowEngine,
  dir: string | readonly string[],
  factory?: WorkflowClassFactory,
): Promise<WorkflowMeta[]> {
  const discovered = await discoverWorkflows(dir);
  for (const { cls } of discovered) await registerWorkflowClass(engine, cls, factory);
  return discovered.map((d) => d.meta);
}

/**
 * The shape of the build-time barrel generated by the Assembler `init` hook
 * (`@adonis-agora/durable/hooks/workflows`): a map of stable key → lazy module import, e.g.
 * `{ Charge: () => import('#workflows/charge_workflow') }`, nested one level per sub-directory
 * (`{ billing: { Refund: () => import(...) } }`). The exact key is irrelevant here — we register
 * every workflow export of every module (`BaseWorkflow` subclass), identical to the runtime scan.
 * When the hook's `source` lists several directories it writes a {@link RootedBarrel} array instead.
 */
export type WorkflowsBarrel = BarrelTree;

/**
 * Register every workflow class reachable from a generated {@link WorkflowsBarrel} (`BaseWorkflow`
 * subclass) — or from the multi-root {@link RootedBarrel} array — by awaiting each lazy module import
 * and registering each workflow export: the build-time equivalent of {@link registerWorkflowsFromDir},
 * with no runtime `readdir`. Each module is imported once and each class registered once (deduped),
 * so a class re-exported from several modules is safe. Same cross-root duplicate rule as the scan.
 * Returns the registered metadata so the caller can log what was wired.
 */
export async function registerWorkflowsFromBarrel(
  engine: WorkflowEngine,
  barrel: WorkflowsBarrel | readonly RootedBarrel[],
  factory?: WorkflowClassFactory,
): Promise<WorkflowMeta[]> {
  const discovered = await collectWorkflows(barrelModules(barrel));
  for (const { cls } of discovered) await registerWorkflowClass(engine, cls, factory);
  return discovered.map((d) => d.meta);
}

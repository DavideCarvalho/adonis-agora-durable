import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowEngine } from './engine.js';
import { type WorkflowMeta, workflowMeta, workflowSchedules } from './workflow-ref.js';

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
  engine.register(
    meta.name,
    meta.version,
    (ctx, input) => Promise.resolve(instance.run(ctx, input)),
    {
      ...(meta.tags ? { tags: meta.tags } : {}),
      ...(meta.executionTimeout !== undefined ? { executionTimeout: meta.executionTimeout } : {}),
      ...(meta.onEvent ? { onEvent: meta.onEvent } : {}),
      ...(meta.singleton ? { singleton: meta.singleton } : {}),
    },
  );
  // Collect any colocated `static schedule` on the class so the worker loop can fire it alongside the
  // config schedules. Both discovery paths (dir scan + generated barrel) funnel through here, so this
  // is the single place that wires colocation.
  const schedules = workflowSchedules(cls);
  if (schedules.length > 0) engine.registerSchedules(schedules);
  return true;
}

/**
 * Pick the module extension a directory scan should import, from the `readdir` entries already in
 * hand — NOT from this library's own compiled file. A consuming app resolves this library as built
 * `.js` from `node_modules`, but its own `app/workflows` / `app/steps` are `.ts` in dev; deriving the
 * extension from `import.meta.url` (the old bug) always picked `.js` in that setup and silently
 * discovered nothing, because every entry was then skipped.
 *
 * Rules, in order:
 * 1. `.d.ts` entries are never importable modules — ignored entirely.
 * 2. If any remaining entry ends in `.ts`, the scan imports `.ts` files.
 * 3. Otherwise, if any entry ends in `.js`, the scan imports `.js` files.
 * 4. If neither is present, returns `null` (the scan registers nothing).
 *
 * This preserves the original de-duplication intent: a directory containing both a built `foo.js`
 * and its source `foo.ts` resolves to `.ts` only, so the same module is never registered twice.
 * Shared with {@link import('./step-discovery.js').registerStepsFromDir} so the two scanners can't
 * drift apart again.
 */
export function pickModuleExt(entries: readonly string[]): '.ts' | '.js' | null {
  let hasTs = false;
  let hasJs = false;
  for (const entry of entries) {
    if (entry.endsWith('.d.ts')) continue;
    const ext = extname(entry);
    if (ext === '.ts') hasTs = true;
    else if (ext === '.js') hasJs = true;
  }
  if (hasTs) return '.ts';
  if (hasJs) return '.js';
  return null;
}

/**
 * Scan a directory RECURSIVELY for modules and collect every exported workflow class — a
 * `BaseWorkflow` subclass (the default export and any named export are considered) — so nested
 * conventions like
 * `app/workflows/billing/charge_workflow.ts` are found, matching `make:workflow`'s nested-path
 * scaffolding. Only the extension present in `dir` is imported (see {@link pickModuleExt}), and
 * each module path is visited once, so a built `.js` and a dev `.ts` of the same module never both
 * register. Missing directory → empty list (the convention is opt-in: no `app/workflows`, nothing to
 * register).
 */
export async function discoverWorkflows(dir: string): Promise<DiscoveredWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const moduleExt = pickModuleExt(entries);
  const found: DiscoveredWorkflow[] = [];
  if (moduleExt === null) return found;
  const seen = new Set<unknown>();
  for (const entry of entries.sort()) {
    if (extname(entry) !== moduleExt || entry.endsWith(`.d${moduleExt}`)) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const meta = workflowMeta(exported);
      if (!meta) continue;
      seen.add(exported);
      found.push({ meta, cls: exported as DiscoveredWorkflowClass });
    }
  }
  return found;
}

/**
 * Discover every workflow class (`BaseWorkflow` subclass) under `dir` and register each on the
 * engine. Returns the registered metadata so the caller can log what was wired.
 * Best-effort over a missing directory.
 */
export async function registerWorkflowsFromDir(
  engine: WorkflowEngine,
  dir: string,
  factory?: WorkflowClassFactory,
): Promise<WorkflowMeta[]> {
  const discovered = await discoverWorkflows(dir);
  for (const { cls } of discovered) await registerWorkflowClass(engine, cls, factory);
  return discovered.map((d) => d.meta);
}

/**
 * The shape of the build-time barrel generated by the Assembler `init` hook
 * (`@adonis-agora/durable/hooks/workflows`): a map of stable key → lazy module import, e.g.
 * `{ Charge: () => import('#workflows/charge_workflow') }`. The exact key is irrelevant here — we
 * register every workflow export of every module (`BaseWorkflow` subclass), identical to the runtime
 * scan.
 */
export type WorkflowsBarrel = Record<string, () => Promise<Record<string, unknown>>>;

/**
 * Register every workflow class reachable from a generated {@link WorkflowsBarrel} (`BaseWorkflow`
 * subclass), by awaiting each lazy module import and registering each
 * workflow export — the build-time equivalent of {@link registerWorkflowsFromDir}, with no runtime
 * `readdir`. Each module is imported once and each class registered once (deduped), so a class
 * re-exported from several modules is safe. Returns the registered metadata so the caller can log
 * what was wired.
 */
export async function registerWorkflowsFromBarrel(
  engine: WorkflowEngine,
  barrel: WorkflowsBarrel,
  factory?: WorkflowClassFactory,
): Promise<WorkflowMeta[]> {
  const registered: WorkflowMeta[] = [];
  const seen = new Set<unknown>();
  for (const load of Object.values(barrel)) {
    const mod = await load();
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const meta = workflowMeta(exported);
      if (!meta) continue;
      seen.add(exported);
      await registerWorkflowClass(engine, exported, factory);
      registered.push(meta);
    }
  }
  return registered;
}

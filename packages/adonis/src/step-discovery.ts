import {
  type BarrelTree,
  barrelModules,
  type DiscoveryModule,
  DuplicateDiscoveryError,
  type RootedBarrel,
  scanDirsModules,
} from './discovery-roots.js';
import type { StepLogger } from './interfaces.js';
import type { StepHandler } from './protocol.js';
import { validateStandard } from './standard-schema.js';
import { DURABLE_STEP_NAME } from './step-name-symbol.js';
import { type DurableStepMeta, stepMetaOf } from './step-ref.js';

/** The narrow serve surface step discovery registers handlers on — satisfied by every transport
 *  (`InMemoryTransport`, `EventEmitterTransport`, `QueueTransport`, `DbTransport`). */
export interface StepServer {
  handle(name: string, fn: StepHandler): void;
}

/** A discovered step handler: its routing metadata + the (already-bound) function to serve. */
export interface DiscoveredStep {
  meta: DurableStepMeta;
  handler: (input: unknown, log: StepLogger) => unknown | Promise<unknown>;
}

/** Wrap a handler with the opt-in Standard Schema validation its `@Step`/`defineStep` metadata
 *  declared: `input` is validated before the body runs (the body receives the schema's OUTPUT value),
 *  `output` before the result is handed back. A failure throws a non-retryable
 *  `SchemaValidationError`. A handler with neither schema is served as-is (compile-time types only). */
function validating(step: DiscoveredStep): StepHandler {
  const { meta, handler } = step;
  if (!meta.input && !meta.output) return handler;
  return async (input: unknown, log: StepLogger) => {
    const parsed = meta.input
      ? await validateStandard(meta.input, input, `step "${meta.name}" input`, 'invalid_input')
      : input;
    const output = await handler(parsed, log);
    return meta.output
      ? validateStandard(meta.output, output, `step "${meta.name}" output`, 'invalid_output')
      : output;
  };
}

/**
 * Register a single discovered step on `server` under its stamped name, wrapping it with any
 * declared schema validation. The low-level `transport.handle(name, fn)` stays the escape hatch — this
 * is the convention the `app/steps` discovery builds on.
 */
export function registerStep(server: StepServer, step: DiscoveredStep): void {
  server.handle(step.meta.name, validating(step));
}

/**
 * A factory that instantiates a class carrying `@Step` methods, called **on every handler
 * invocation**: each step execution runs on a fresh instance, like an `@adonisjs/queue` job. The
 * AdonisJS provider passes `(Ctor) => app.container.make(Ctor)`, so constructor dependency injection
 * (`@inject()`) works for step classes and a `container.swap(Service, ...)` made after boot is seen by
 * the next execution. May return the instance or a Promise (the container's `make` is async). Never
 * called for a `defineStep(...)` function — there is nothing to build. Without a factory, discovery
 * keeps the old behaviour: one `new Ctor()` at registration, reused for every call.
 */
export type StepClassFactory = (ctor: new () => object) => object | Promise<object>;

function defaultStepClassFactory(ctor: new () => object): object {
  return new ctor();
}

/** The `@Step`-stamped method keys on a class's prototype; empty for anything that is not a class
 *  with stamped methods. */
function stampedStepKeys(exported: unknown): string[] {
  if (typeof exported !== 'function' || !exported.prototype) return [];
  const proto = exported.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter((key) => {
    const value = proto[key];
    return (
      typeof value === 'function' &&
      typeof (value as { [DURABLE_STEP_NAME]?: unknown })[DURABLE_STEP_NAME] === 'string'
    );
  });
}

/** Bind each stamped method of `exported` (a class) to `instance`. */
function bindStepMethods(exported: unknown, instance: object, keys: string[]): DiscoveredStep[] {
  const proto = (exported as { prototype: Record<string, unknown> }).prototype;
  const target = instance as Record<string, unknown>;
  const found: DiscoveredStep[] = [];
  for (const key of keys) {
    const meta = stepMetaOf(proto[key]);
    if (!meta) continue;
    found.push({ meta, handler: (target[key] as StepHandler).bind(instance) });
  }
  return found;
}

/**
 * Collect every `@Step`/`defineStep` handler reachable from an exported value:
 * - a `defineStep(...)` function (stamped directly) → one handler, bound as-is.
 * - a class with `@Step`-decorated methods → instantiate once with `new Ctor()` and bind each stamped
 *   method.
 * Anything else is ignored. So a module can `export` either style (or both) and be discovered.
 *
 * Synchronous, so it can only build a class with `new Ctor()` (no constructor dependencies). The
 * directory/barrel discovery ({@link registerStepsFromDir}, {@link registerStepsFromBarrel}) takes a
 * {@link StepClassFactory} instead, which is how the AdonisJS provider injects dependencies.
 */
export function collectSteps(exported: unknown): DiscoveredStep[] {
  const directMeta = stepMetaOf(exported);
  if (directMeta) return [{ meta: directMeta, handler: exported as DiscoveredStep['handler'] }];
  const keys = stampedStepKeys(exported);
  if (keys.length === 0) return [];
  return bindStepMethods(exported, defaultStepClassFactory(exported as new () => object), keys);
}

/**
 * {@link collectSteps}, but with `factory` each handler resolves its instance through it on every
 * call (and calls the method on that instance). Without `factory` this IS {@link collectSteps}.
 */
function collectStepsWith(exported: unknown, factory?: StepClassFactory): DiscoveredStep[] {
  if (!factory) return collectSteps(exported);
  const directMeta = stepMetaOf(exported);
  if (directMeta) return [{ meta: directMeta, handler: exported as DiscoveredStep['handler'] }];
  const keys = stampedStepKeys(exported);
  if (keys.length === 0) return [];
  const Ctor = exported as new () => object;
  const proto = Ctor.prototype as Record<string, unknown>;
  const found: DiscoveredStep[] = [];
  for (const key of keys) {
    const meta = stepMetaOf(proto[key]);
    if (!meta) continue;
    found.push({
      meta,
      handler: async (input: unknown, log: StepLogger) => {
        const instance = (await factory(Ctor)) as Record<string, unknown>;
        return (instance[key] as StepHandler).call(instance, input, log);
      },
    });
  }
  return found;
}

/** Discover + register every `@Step`/`defineStep` reachable from `exports` (e.g. a module's exports)
 *  onto `server`. De-duplicated by routing name (last wins). Returns the registered metadata. */
export function registerSteps(server: StepServer, exports: Iterable<unknown>): DurableStepMeta[] {
  const registered: DurableStepMeta[] = [];
  const seen = new Set<string>();
  for (const exported of exports) {
    for (const step of collectSteps(exported)) {
      if (seen.has(step.meta.name)) continue;
      seen.add(step.meta.name);
      registerStep(server, step);
      registered.push(step.meta);
    }
  }
  return registered;
}

/** The routing names an export would serve, read off its stamps WITHOUT instantiating anything. */
function stepNamesOf(exported: unknown): string[] {
  const direct = stepMetaOf(exported);
  if (direct) return [direct.name];
  if (typeof exported !== 'function' || !exported.prototype) return [];
  const proto = exported.prototype as Record<string, unknown>;
  const names: string[] = [];
  for (const key of Object.getOwnPropertyNames(proto)) {
    const value = proto[key];
    if (typeof value !== 'function') continue;
    const name = stepMetaOf(value)?.name;
    if (name) names.push(name);
  }
  return names;
}

/**
 * Register every step reachable from `modules`, in order. Per module this is exactly
 * {@link registerSteps} — the single-directory behaviour, kept as-is: inside one root a name served
 * twice is served by the later module.
 *
 * Across roots, a step name already served from another root by a DIFFERENT export throws a
 * {@link DuplicateDiscoveryError} naming both files — checked for every module BEFORE any handler is
 * registered, so a clash never leaves a half-served transport. The same export reachable from two
 * roots (a re-export, or overlapping roots) is served once.
 */
async function registerStepModules(
  server: StepServer,
  modules: readonly DiscoveryModule[],
  factory: StepClassFactory | undefined,
): Promise<DurableStepMeta[]> {
  const owners = new Map<string, { root: string; file: string; source: unknown }>();
  const plan: unknown[][] = [];
  for (const { root, file, load } of modules) {
    const mod = await load();
    const exports: unknown[] = [];
    for (const exported of Object.values(mod)) {
      let servedElsewhere = false;
      for (const name of stepNamesOf(exported)) {
        const owner = owners.get(name);
        if (!owner) {
          owners.set(name, { root, file, source: exported });
          continue;
        }
        if (owner.root === root) continue;
        if (owner.source !== exported) {
          throw new DuplicateDiscoveryError('step', name, [owner.file, file]);
        }
        servedElsewhere = true;
      }
      if (!servedElsewhere) exports.push(exported);
    }
    plan.push(exports);
  }
  // Collect every module's handlers BEFORE serving any, so a class whose `new Ctor()` throws (no
  // factory) fails discovery without leaving a half-served transport. With a factory nothing is
  // built here: each handler resolves its instance when it runs.
  const collected: DiscoveredStep[][] = [];
  for (const exports of plan) {
    // Per module, exactly `registerSteps`: de-duplicated by routing name, first export wins.
    const steps: DiscoveredStep[] = [];
    const inModule = new Set<string>();
    for (const exported of exports) {
      for (const step of collectStepsWith(exported, factory)) {
        if (inModule.has(step.meta.name)) continue;
        inModule.add(step.meta.name);
        steps.push(step);
      }
    }
    collected.push(steps);
  }
  const registered: DurableStepMeta[] = [];
  const seen = new Set<string>();
  for (const steps of collected) {
    for (const step of steps) {
      registerStep(server, step);
      if (seen.has(step.meta.name)) continue;
      seen.add(step.meta.name);
      registered.push(step.meta);
    }
  }
  return registered;
}

/**
 * Scan `dir` — one directory or several — RECURSIVELY and register every exported `@Step` class /
 * `defineStep` handler on `server`: the `app/steps` convention, mirroring `app/workflows` discovery.
 * Only the extension present in each directory is imported (see `pickModuleExt`). Missing
 * directory → nothing from it (the convention is opt-in). With several directories the same step
 * name defined by different handlers in two of them throws a {@link DuplicateDiscoveryError}.
 * Returns the registered metadata.
 *
 * `server` is anything with `handle(name, fn)`: a transport, the store-less `WorkerRuntime`, or the
 * `WorkflowEngine` itself (it forwards to its primary transport) — the latter is how app code
 * serves an extra directory from a preload: `await registerStepsFromDir(engine, dir)`.
 *
 * `factory` builds each class that carries `@Step` methods, once per handler call (see
 * {@link StepClassFactory}); omitted, each class is built once with `new Ctor()` at registration.
 * Pass `(Ctor) => app.container.make(Ctor)` for constructor injection — the provider does.
 * `defineStep(...)` functions are served as-is either way.
 */
export async function registerStepsFromDir(
  server: StepServer,
  dir: string | readonly string[],
  factory?: StepClassFactory,
): Promise<DurableStepMeta[]> {
  return registerStepModules(
    server,
    await scanDirsModules(typeof dir === 'string' ? [dir] : dir),
    factory,
  );
}

/** The build-time barrel shape the Assembler `init` hook generates for `app/steps` (key → lazy
 *  module import, nested per sub-directory), mirroring
 *  {@link import('./workflow-discovery.js').WorkflowsBarrel}. A multi-root hook writes a
 *  {@link RootedBarrel} array instead. */
export type StepsBarrel = BarrelTree;

/** Register every `@Step`/`defineStep` reachable from a generated {@link StepsBarrel} (or a
 *  multi-root {@link RootedBarrel} array) onto `server` — the build-time equivalent of
 *  {@link registerStepsFromDir} with no runtime `readdir`, same cross-root duplicate rule and the
 *  same optional {@link StepClassFactory}. */
export async function registerStepsFromBarrel(
  server: StepServer,
  barrel: StepsBarrel | readonly RootedBarrel[],
  factory?: StepClassFactory,
): Promise<DurableStepMeta[]> {
  return registerStepModules(server, barrelModules(barrel), factory);
}

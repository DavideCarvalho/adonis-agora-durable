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
 * Collect every `@Step`/`defineStep` handler reachable from an exported value:
 * - a `defineStep(...)` function (stamped directly) → one handler, bound as-is.
 * - a class with `@Step`-decorated methods → instantiate once and bind each stamped method.
 * Anything else is ignored. So a module can `export` either style (or both) and be discovered.
 */
export function collectSteps(exported: unknown): DiscoveredStep[] {
  const found: DiscoveredStep[] = [];
  // A `defineStep(...)` handler: the function itself carries the stamp.
  const directMeta = stepMetaOf(exported);
  if (directMeta) {
    found.push({ meta: directMeta, handler: exported as DiscoveredStep['handler'] });
    return found;
  }
  // A class with `@Step` methods: scan its prototype for stamped methods and bind them to an instance.
  if (typeof exported === 'function' && exported.prototype) {
    const proto = exported.prototype as Record<string, unknown>;
    const stamped = Object.getOwnPropertyNames(proto).filter((key) => {
      const value = proto[key];
      return (
        typeof value === 'function' &&
        typeof (value as { [DURABLE_STEP_NAME]?: unknown })[DURABLE_STEP_NAME] === 'string'
      );
    });
    if (stamped.length > 0) {
      const Ctor = exported as new () => Record<string, (...args: unknown[]) => unknown>;
      const instance = new Ctor();
      for (const key of stamped) {
        const method = proto[key] as (...args: unknown[]) => unknown;
        const meta = stepMetaOf(method);
        if (!meta) continue;
        found.push({ meta, handler: (instance[key] as StepHandler).bind(instance) });
      }
    }
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
  const registered: DurableStepMeta[] = [];
  const seen = new Set<string>();
  for (const exports of plan) {
    for (const meta of registerSteps(server, exports)) {
      if (seen.has(meta.name)) continue;
      seen.add(meta.name);
      registered.push(meta);
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
 */
export async function registerStepsFromDir(
  server: StepServer,
  dir: string | readonly string[],
): Promise<DurableStepMeta[]> {
  return registerStepModules(server, await scanDirsModules(typeof dir === 'string' ? [dir] : dir));
}

/** The build-time barrel shape the Assembler `init` hook generates for `app/steps` (key → lazy
 *  module import, nested per sub-directory), mirroring
 *  {@link import('./workflow-discovery.js').WorkflowsBarrel}. A multi-root hook writes a
 *  {@link RootedBarrel} array instead. */
export type StepsBarrel = BarrelTree;

/** Register every `@Step`/`defineStep` reachable from a generated {@link StepsBarrel} (or a
 *  multi-root {@link RootedBarrel} array) onto `server` — the build-time equivalent of
 *  {@link registerStepsFromDir} with no runtime `readdir`, same cross-root duplicate rule. */
export async function registerStepsFromBarrel(
  server: StepServer,
  barrel: StepsBarrel | readonly RootedBarrel[],
): Promise<DurableStepMeta[]> {
  return registerStepModules(server, barrelModules(barrel));
}

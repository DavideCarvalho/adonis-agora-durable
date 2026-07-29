import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StepLogger } from './interfaces.js';
import type { StepHandler } from './protocol.js';
import { DURABLE_STEP_NAME } from './step-name-symbol.js';
import { type DurableStepMeta, stepMetaOf } from './step-ref.js';
import { pickModuleExt } from './workflow-discovery.js';

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

/** Wrap a handler with the opt-in zod validation its `@Step`/`defineStep` metadata declared: `input`
 *  is parsed before the body runs, `output` before the result is handed back. A handler with neither
 *  schema is served as-is (compile-time types only). */
function validating(step: DiscoveredStep): StepHandler {
  const { meta, handler } = step;
  if (!meta.input && !meta.output) return handler;
  return async (input: unknown, log: StepLogger) => {
    const parsed = meta.input ? meta.input.parse(input) : input;
    const output = await handler(parsed, log);
    return meta.output ? meta.output.parse(output) : output;
  };
}

/**
 * Register a single discovered step on `server` under its stamped name, wrapping it with any
 * declared zod validation. The low-level `transport.handle(name, fn)` stays the escape hatch — this
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

/**
 * Scan `dir` RECURSIVELY for modules and register every exported `@Step` class / `defineStep`
 * handler on `server` — the `app/steps` convention, mirroring `app/workflows` discovery. Only the
 * extension present in `dir` is imported (see {@link pickModuleExt}). Missing directory → no-op
 * (the convention is opt-in). Returns the registered metadata.
 */
export async function registerStepsFromDir(
  server: StepServer,
  dir: string,
): Promise<DurableStepMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const moduleExt = pickModuleExt(entries);
  const registered: DurableStepMeta[] = [];
  if (moduleExt === null) return registered;
  const seen = new Set<string>();
  for (const entry of entries.sort()) {
    if (extname(entry) !== moduleExt || entry.endsWith(`.d${moduleExt}`)) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    for (const meta of registerSteps(server, Object.values(mod))) {
      if (seen.has(meta.name)) continue;
      seen.add(meta.name);
      registered.push(meta);
    }
  }
  return registered;
}

/** The build-time barrel shape the Assembler `init` hook generates for `app/steps` (key → lazy
 *  module import), mirroring {@link import('./workflow-discovery.js').WorkflowsBarrel}. */
export type StepsBarrel = Record<string, () => Promise<Record<string, unknown>>>;

/** Register every `@Step`/`defineStep` reachable from a generated {@link StepsBarrel} onto `server`
 *  — the build-time equivalent of {@link registerStepsFromDir} with no runtime `readdir`. */
export async function registerStepsFromBarrel(
  server: StepServer,
  barrel: StepsBarrel,
): Promise<DurableStepMeta[]> {
  const registered: DurableStepMeta[] = [];
  const seen = new Set<string>();
  for (const load of Object.values(barrel)) {
    const mod = await load();
    for (const meta of registerSteps(server, Object.values(mod))) {
      if (seen.has(meta.name)) continue;
      seen.add(meta.name);
      registered.push(meta);
    }
  }
  return registered;
}

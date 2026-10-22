import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Shared plumbing for multi-root discovery: `workflowsPath` / `stepsPath` (and the assembler hooks'
 * `source`) accept one directory or several, and both the runtime directory scan and the generated
 * barrels walk every root the same way.
 */

/** A lazy module import, as written by the generated barrels: `() => import('#workflows/charge')`. */
export type BarrelModuleLoader = () => Promise<Record<string, unknown>>;

/**
 * A single-root generated barrel: stable key → lazy module import. The Assembler `IndexGenerator`
 * nests modules that live in sub-directories (`app/workflows/billing/refund_workflow.ts` becomes
 * `{ billing: { Refund: () => import(...) } }`), so a value is either a loader or another level.
 */
export interface BarrelTree {
  [key: string]: BarrelModuleLoader | BarrelTree;
}

/**
 * One root of a multi-root generated barrel. The hooks write an ARRAY of these when their `source`
 * names several directories: `root` is the directory (relative to the app root) and `modules` maps
 * each module's app-relative file path to its lazy import. The file path keys are what the
 * cross-root duplicate check quotes in its error.
 */
export interface RootedBarrel {
  root: string;
  modules: Record<string, BarrelModuleLoader>;
}

/** One importable module discovery will visit, tagged with the root it was found under. */
export interface DiscoveryModule {
  /** The discovery root (directory or barrel root) the module belongs to. */
  root: string;
  /** Where the module lives: an absolute path for a directory scan, the barrel key for a barrel. */
  file: string;
  load: BarrelModuleLoader;
}

/**
 * Normalise a `workflowsPath` / `stepsPath` value into the list of roots to scan. `undefined` falls
 * back to `fallback`; `false` and an empty array both mean "discovery off" and return `[]`. Repeated
 * entries are dropped so the same directory is never scanned twice.
 */
export function discoveryRoots(
  value: string | readonly string[] | false | undefined,
  fallback: string,
): string[] {
  if (value === false) return [];
  const list = value === undefined ? [fallback] : typeof value === 'string' ? [value] : value;
  return [...new Set(list)];
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
 * Shared by the workflow and step scanners so the two can't drift apart again.
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
 * List the importable modules under `dir` RECURSIVELY (sorted, one extension — see
 * {@link pickModuleExt}), tagged with `root`. Missing directory → `[]` (the convention is opt-in).
 */
export async function scanDirModules(dir: string, root: string = dir): Promise<DiscoveryModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const moduleExt = pickModuleExt(entries);
  if (moduleExt === null) return [];
  const modules: DiscoveryModule[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry) !== moduleExt || entry.endsWith(`.d${moduleExt}`)) continue;
    const file = join(dir, entry);
    modules.push({
      root,
      file,
      load: async () => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
    });
  }
  return modules;
}

/** Scan every directory in `dirs` (in order) — {@link scanDirModules} per root. */
export async function scanDirsModules(dirs: readonly string[]): Promise<DiscoveryModule[]> {
  const modules: DiscoveryModule[] = [];
  for (const dir of dirs) modules.push(...(await scanDirModules(dir)));
  return modules;
}

/** Human-readable form of a roots list for log lines: `app/steps` or `app/a, app/b`. */
export function describeRoots(roots: readonly string[]): string {
  return roots.join(', ');
}

/** True when `barrel` is the multi-root array shape rather than a single-root key → loader tree. */
export function isRootedBarrels(
  barrel: BarrelTree | readonly RootedBarrel[],
): barrel is readonly RootedBarrel[] {
  return Array.isArray(barrel);
}

/**
 * Flatten a generated barrel into the modules discovery visits, in the barrel's own order. A
 * single-root tree is walked depth-first (nested sub-directory levels included) and every module is
 * tagged with the same root, so no cross-root check can fire; a multi-root array keeps each root.
 */
export function barrelModules(barrel: BarrelTree | readonly RootedBarrel[]): DiscoveryModule[] {
  const modules: DiscoveryModule[] = [];
  if (isRootedBarrels(barrel)) {
    for (const { root, modules: entries } of barrel) {
      for (const [file, load] of Object.entries(entries)) modules.push({ root, file, load });
    }
    return modules;
  }
  const walk = (tree: BarrelTree, prefix: string) => {
    for (const [key, value] of Object.entries(tree)) {
      const path = prefix ? `${prefix}/${key}` : key;
      if (typeof value === 'function') modules.push({ root: '', file: path, load: value });
      else if (value && typeof value === 'object') walk(value, path);
    }
  };
  walk(barrel, '');
  return modules;
}

/**
 * The error thrown when two discovery roots define the same workflow (name + version) or step name
 * with different classes / handlers. Within ONE root the historical behaviour is kept (last
 * registration wins), so this only fires across roots — e.g. two bounded contexts that both declared
 * a `charge` workflow.
 */
export class DuplicateDiscoveryError extends Error {
  /**
   * @param kind  what clashed.
   * @param id    the clashing identity: the step name, or `name@version` for a workflow.
   * @param files the two modules defining it (first registered, then the clashing one).
   */
  constructor(
    readonly kind: 'workflow' | 'step',
    readonly id: string,
    readonly files: readonly [string, string],
  ) {
    const at = id.lastIndexOf('@');
    const label =
      kind === 'workflow' && at > 0
        ? `workflow "${id.slice(0, at)}" (version ${id.slice(at + 1)})`
        : `${kind} "${id}"`;
    super(
      `@agora/durable: ${label} is defined in two discovery roots: ${files[0]} and ${files[1]}. ` +
        `${kind === 'workflow' ? 'Workflow names (per version)' : 'Step names'} must be unique across ` +
        `every ${kind === 'workflow' ? 'workflowsPath' : 'stepsPath'} directory; rename one of them.`,
    );
    this.name = 'DuplicateDiscoveryError';
  }
}

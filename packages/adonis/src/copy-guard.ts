import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ORIGIN } from './package-origin.js';

/**
 * One loaded copy of this package: its version and the real path of its package root. Two copies are
 * the same when their roots are, so the `src` and `dist` builds of one checkout, or one module
 * evaluated twice (test runners reload modules), count once.
 */
export interface DurableCopy {
  version: string;
  root: string;
}

/** What every loaded copy writes to, shared through `globalThis` so copies can see each other. */
export interface DurableCopyRegistry {
  copies: Map<string, DurableCopy>;
  /** Set once a provider booted: a copy that loads after that cannot be caught at boot any more. */
  booted: boolean;
}

export const DURABLE_COPIES_KEY = Symbol.for('@adonis-agora/durable.copies');

export const DUPLICATE_COPY_DOCS =
  'https://davidecarvalho.github.io/agora/docs/durable/troubleshooting#two-copies-of-adonis-agoradurable';

/** Thrown at boot when two different installs of `@adonis-agora/durable` are loaded in one process. */
export class DuplicateDurableCopyError extends Error {
  readonly copies: DurableCopy[];
  constructor(copies: DurableCopy[]) {
    super(duplicateCopyMessage(copies));
    this.name = 'DuplicateDurableCopyError';
    this.copies = copies;
  }
}

/** The process-wide registry, created on first use. */
export function durableCopyRegistry(): DurableCopyRegistry {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[DURABLE_COPIES_KEY] as Partial<DurableCopyRegistry> | undefined;
  if (existing?.copies instanceof Map) return existing as DurableCopyRegistry;
  const fresh: DurableCopyRegistry = { copies: new Map(), booted: false };
  slot[DURABLE_COPIES_KEY] = fresh;
  return fresh;
}

/** Every distinct copy registered so far. */
export function durableCopies(registry = durableCopyRegistry()): DurableCopy[] {
  return [...registry.copies.values()];
}

/**
 * Record a copy. The same root registering again is a no-op. A distinct copy that loads after a
 * provider booted throws right away, since no boot step is left to report it.
 */
export function registerDurableCopy(copy: DurableCopy, registry = durableCopyRegistry()): void {
  if (registry.copies.has(copy.root)) return;
  registry.copies.set(copy.root, copy);
  if (registry.booted) assertSingleDurableCopy(registry);
}

/** Throws {@link DuplicateDurableCopyError} when more than one distinct copy is registered. */
export function assertSingleDurableCopy(registry = durableCopyRegistry()): void {
  const copies = durableCopies(registry);
  if (copies.length > 1) throw new DuplicateDurableCopyError(copies);
}

/** Called by the provider: check now, and make any copy that loads later fail on load. */
export function sealDurableCopies(registry = durableCopyRegistry()): void {
  assertSingleDurableCopy(registry);
  registry.booted = true;
}

/** The fix for two copies, one line. */
export const DUPLICATE_COPY_FIX =
  'Make every package resolve one copy: declare the same peer dependency versions in the app as in the workspace packages that depend on @adonis-agora/durable (or pin them with pnpm.overrides), reinstall, and check that `pnpm why @adonis-agora/durable` shows a single variant.';

export function duplicateCopyMessage(copies: readonly DurableCopy[]): string {
  const list = copies.map((c) => `  - ${c.version} at ${c.root}`).join('\n');
  return [
    `${PACKAGE_ORIGIN} is loaded ${copies.length} times, from different installs:`,
    list,
    'Each copy has its own WorkflowEngine class, so a workflow from one copy cannot resolve the engine the other copy registered (`Cannot construct "[class WorkflowEngine]" class`).',
    DUPLICATE_COPY_FIX,
    `See ${DUPLICATE_COPY_DOCS}`,
  ].join('\n');
}

/** This module's copy: the real path of the nearest `package.json` named `@adonis-agora/durable`. */
function thisCopy(): DurableCopy {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PACKAGE_ORIGIN) {
        return {
          version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
          root: realPath(dir),
        };
      }
    } catch {
      // No (readable) package.json here: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return { version: 'unknown', root: realPath(start) };
    dir = parent;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

registerDurableCopy(thisCopy());

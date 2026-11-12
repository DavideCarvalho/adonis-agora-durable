import type { HttpContext } from '@adonisjs/core/http';

/*
 * The console switcher registry, version 1, declared here STRUCTURALLY: every `@adonis-agora`
 * console declares the same shapes and binds the same plain value at `'agora.consoles'` when it is
 * the first to boot. No lib imports another; whichever copy creates the registry, the others append
 * to it.
 */

/** The container binding the registry lives at. */
export const AGORA_CONSOLES_BINDING = 'agora.consoles';

/** Bound as a VALUE under `'agora.consoles'`. Data only. */
export interface AgoraConsoleRegistry {
  readonly version: 1;
  readonly entries: AgoraConsoleEntry[];
}

/** The icon a console shows in the switcher. An unknown value renders as `generic`. */
export type AgoraConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

/** One hit of a console's global search. */
export interface AgoraConsoleSearchHit {
  title: string;
  subtitle?: string;
  /** Same-origin absolute path (`/durable#/run/42`). */
  href: string;
}

/** One console the switcher can list. */
export interface AgoraConsoleEntry {
  /** `/^[a-z][a-z0-9-]*$/`: `'durable'`, `'telescope'`, … */
  id: string;
  /** Product title: `'Workflows'`, `'Telescope'`, `'Identity'`. */
  title: string;
  /** The package behind it, shown under the title (`'@adonis-agora/durable'`). */
  package?: string;
  icon: AgoraConsoleIcon;
  /** Same-origin absolute path of the console shell (`/durable`). */
  path: string;
  /** Sort key: durable 10, telescope 20, agent 30, payments 40, media 50, authkit 90. */
  order: number;
  /** The console's RESOLVED gate (the function its own routes call). Never throws. */
  authorize(ctx: HttpContext): Promise<{ allowed: boolean; reason?: string; redirectTo?: string }>;
  /** Global search over this console's data, for a viewer this console already allowed. */
  search?(ctx: HttpContext, q: string, limit: number): Promise<AgoraConsoleSearchHit[]>;
}

/** One console as the switcher endpoint returns it. */
export interface VisibleConsole {
  id: string;
  title: string;
  package?: string;
  icon: AgoraConsoleIcon;
  href: string;
}

/** The answer of `GET <console api>/consoles`. */
export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: VisibleConsole[];
}

/** The answer of `GET <console api>/consoles/search?q=`. */
export interface ConsoleSearchResults {
  version: 1;
  q: string;
  results: Array<{
    id: string;
    title: string;
    icon: AgoraConsoleIcon;
    hits: AgoraConsoleSearchHit[];
  }>;
}

const ID = /^[a-z][a-z0-9-]*$/;
const ICONS = new Set<AgoraConsoleIcon>([
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
]);
/** How long another console's `authorize` (or `search`) may take before it is left out. */
export const PROBE_TIMEOUT_MS = 300;
/** Hits per console in a global search. */
export const SEARCH_HITS_PER_CONSOLE = 5;

/** Whether `path` is a same-origin absolute path (`/x`, never `//host` or a URL). */
export function isSameOriginPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  bindValue(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

interface LoggerLike {
  warn(message: string): void;
}

/**
 * Add a console to the app's switcher registry, creating the registry when this is the first
 * console to boot. Consoles call it from their provider's `boot()`; an app can call it too, for a
 * console it mounts itself. A registry of another version is left alone; a duplicate id is skipped
 * with a warning. Returns whether the entry was added.
 */
export async function registerAgoraConsole(
  container: ContainerLike,
  entry: AgoraConsoleEntry,
  logger?: LoggerLike,
): Promise<boolean> {
  if (!ID.test(entry.id)) {
    throw new Error(`[@adonis-agora/durable] console id ${JSON.stringify(entry.id)} is invalid`);
  }
  if (!isSameOriginPath(entry.path)) {
    throw new Error(
      `[@adonis-agora/durable] console path ${JSON.stringify(entry.path)} must start with a single "/"`,
    );
  }
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) {
    const fresh: AgoraConsoleRegistry = { version: 1, entries: [] };
    container.bindValue(AGORA_CONSOLES_BINDING, fresh);
  }
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as
    | Partial<AgoraConsoleRegistry>
    | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return false;
  if (registry.entries.some((existing) => existing.id === entry.id)) {
    logger?.warn(`[@adonis-agora/durable] console id "${entry.id}" already registered`);
    return false;
  }
  registry.entries.push(entry);
  return true;
}

/** The registry, when one is bound with a version this copy reads. */
export async function readAgoraConsoles(
  container: Pick<ContainerLike, 'hasBinding' | 'make'>,
): Promise<AgoraConsoleRegistry | undefined> {
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) return undefined;
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as
    | Partial<AgoraConsoleRegistry>
    | undefined;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return undefined;
  return registry as AgoraConsoleRegistry;
}

/** How many consoles other than `selfId` are registered (no `authorize` runs). */
export function otherConsoles(registry: AgoraConsoleRegistry | undefined, selfId: string): number {
  return registry ? registry.entries.filter((entry) => entry.id !== selfId).length : 0;
}

/** `work`, or `fallback` when it rejects or takes longer than `ms`. */
async function within<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => fallback),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run `fn` with the probe marker on `ctx`: an `authorize` that writes an audit trail can read
 * `ctx.agoraProbe === true` and skip it, since the switcher only asks, it does not open anything.
 */
async function probing<T>(ctx: HttpContext, fn: () => Promise<T>): Promise<T> {
  const marked = ctx as HttpContext & { agoraProbe?: boolean };
  const previous = marked.agoraProbe;
  marked.agoraProbe = true;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete marked.agoraProbe;
    else marked.agoraProbe = previous;
  }
}

function sorted(entries: readonly AgoraConsoleEntry[]): AgoraConsoleEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function allowedEntries(
  entries: AgoraConsoleEntry[],
  ctx: HttpContext,
  timeoutMs: number,
): Promise<AgoraConsoleEntry[]> {
  const verdicts = await probing(ctx, () =>
    Promise.all(
      entries.map((entry) =>
        within(async () => (await entry.authorize(ctx)).allowed === true, timeoutMs, false),
      ),
    ),
  );
  return entries.filter((_, index) => verdicts[index]);
}

function iconOf(icon: unknown): AgoraConsoleIcon {
  return ICONS.has(icon as AgoraConsoleIcon) ? (icon as AgoraConsoleIcon) : 'generic';
}

/**
 * The consoles other than `selfId` the viewer may open: every other entry's `authorize` runs in
 * parallel, each given {@link PROBE_TIMEOUT_MS}; a timeout, a rejection or any denial hides it. No
 * reason is ever returned.
 */
export async function listVisibleConsoles(
  registry: AgoraConsoleRegistry | undefined,
  selfId: string,
  ctx: HttpContext,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VisibleConsoles> {
  const others = registry
    ? sorted(
        registry.entries.filter((entry) => entry.id !== selfId && isSameOriginPath(entry.path)),
      )
    : [];
  const allowed = await allowedEntries(others, ctx, timeoutMs);
  return {
    version: 1,
    current: selfId,
    consoles: allowed.map((entry) => ({
      id: entry.id,
      title: entry.title,
      ...(entry.package !== undefined ? { package: entry.package } : {}),
      icon: iconOf(entry.icon),
      href: entry.path,
    })),
  };
}

/**
 * Global search: `q` goes to every console the viewer may open that has a `search` (this one
 * included, the viewer is already in it), in parallel, {@link PROBE_TIMEOUT_MS} each, at most
 * {@link SEARCH_HITS_PER_CONSOLE} same-origin hits per console. Consoles with no hit are left out.
 */
export async function searchConsoles(
  registry: AgoraConsoleRegistry | undefined,
  selfId: string,
  ctx: HttpContext,
  q: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ConsoleSearchResults> {
  const query = q.trim().slice(0, 200);
  if (!registry || query === '') return { version: 1, q: query, results: [] };
  const searchable = sorted(
    registry.entries.filter(
      (entry) => typeof entry.search === 'function' && isSameOriginPath(entry.path),
    ),
  );
  const self = searchable.filter((entry) => entry.id === selfId);
  const others = await allowedEntries(
    searchable.filter((entry) => entry.id !== selfId),
    ctx,
    timeoutMs,
  );
  const targets = sorted([...self, ...others]);
  const hits = await probing(ctx, () =>
    Promise.all(
      targets.map((entry) =>
        within(
          async () => (await entry.search?.(ctx, query, SEARCH_HITS_PER_CONSOLE)) ?? [],
          timeoutMs,
          [] as AgoraConsoleSearchHit[],
        ),
      ),
    ),
  );
  const results: ConsoleSearchResults['results'] = [];
  targets.forEach((entry, index) => {
    const safe = (hits[index] ?? [])
      .filter(
        (hit) =>
          typeof hit === 'object' &&
          hit !== null &&
          typeof hit.title === 'string' &&
          isSameOriginPath(hit.href),
      )
      .slice(0, SEARCH_HITS_PER_CONSOLE)
      .map((hit) => ({
        title: hit.title,
        ...(typeof hit.subtitle === 'string' ? { subtitle: hit.subtitle } : {}),
        href: hit.href,
      }));
    if (safe.length > 0) {
      results.push({ id: entry.id, title: entry.title, icon: iconOf(entry.icon), hits: safe });
    }
  });
  return { version: 1, q: query, results };
}

/** What {@link durableConsoleSearch} reads: a run by id, and workflow names with their counts. */
export interface DurableSearchSource {
  getRun(id: string): Promise<{ id: string; workflow: string; status: string } | null>;
  /** Workflow names containing `q`, with their run counts. */
  workflows(q: string, limit: number): Promise<Array<{ value: string | null; count: number }>>;
}

/**
 * The durable console's global search: an exact run id opens that run, and workflow names that
 * contain `q` open the workflow's page. `base` is the console's mount path (`''` at the root).
 */
export function durableConsoleSearch(
  source: () => Promise<DurableSearchSource>,
  base: string,
): (ctx: HttpContext, q: string, limit: number) => Promise<AgoraConsoleSearchHit[]> {
  const shell = base === '' ? '/' : base;
  return async (_ctx, q, limit) => {
    const reader = await source();
    const hits: AgoraConsoleSearchHit[] = [];
    const run = await reader.getRun(q).catch(() => null);
    if (run) {
      hits.push({
        title: run.id,
        subtitle: `run · ${run.workflow} · ${run.status}`,
        href: `${shell}#/run/${encodeURIComponent(run.id)}`,
      });
    }
    const rows = await reader.workflows(q, limit).catch(() => []);
    for (const row of rows) {
      if (hits.length >= limit) break;
      if (row.value === null) continue;
      hits.push({
        title: row.value,
        subtitle: `workflow · ${row.count} ${row.count === 1 ? 'run' : 'runs'}`,
        href: `${shell}#/workflow/${encodeURIComponent(row.value)}`,
      });
    }
    return hits.slice(0, limit);
  };
}

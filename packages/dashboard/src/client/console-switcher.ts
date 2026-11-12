/**
 * The Agora console switcher's client side: what the provider put in the page's config block, and
 * the two requests the switcher makes (the consoles this viewer may open, and a search across them).
 * Self-contained on purpose: every Agora console SPA carries the same copy.
 */

/** The `switcher` field of the page's config data block. */
export interface SwitcherConfig {
  endpoint: string;
  others: number;
}

export type ConsoleIconKey =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

export interface SwitcherConsole {
  id: string;
  title: string;
  package?: string;
  icon: ConsoleIconKey;
  href: string;
}

export interface SwitcherSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

export interface SwitcherSearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: SwitcherSearchHit[];
}

const ICONS: readonly ConsoleIconKey[] = [
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
];

/** A same-origin absolute path: `/x`, never `//host`, a scheme, or anything else. */
export function isSafeHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
}

export function iconKey(value: unknown): ConsoleIconKey {
  return ICONS.includes(value as ConsoleIconKey) ? (value as ConsoleIconKey) : 'generic';
}

/** The `switcher` field of the config block `elementId`, or `undefined` when absent or unusable. */
export function readSwitcherConfig(elementId: string): SwitcherConfig | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.getElementById(elementId);
  if (element === null) return undefined;
  try {
    const parsed = JSON.parse(element.textContent ?? '') as { switcher?: unknown };
    const switcher = parsed?.switcher as Partial<SwitcherConfig> | undefined;
    if (!switcher || !isSafeHref(switcher.endpoint)) return undefined;
    if (typeof switcher.others !== 'number' || switcher.others <= 0) return undefined;
    return { endpoint: switcher.endpoint, others: switcher.others };
  } catch {
    return undefined;
  }
}

let cached: { endpoint: string; result: Promise<SwitcherConsole[]> } | undefined;

/** The consoles this viewer may open (fetched once per page). Any failure reads as "none". */
export function loadConsoles(config: SwitcherConfig): Promise<SwitcherConsole[]> {
  if (cached?.endpoint === config.endpoint) return cached.result;
  const result = fetch(config.endpoint, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (!res.ok) return [];
      const body = (await res.json()) as { consoles?: unknown };
      return sanitizeConsoles(body?.consoles);
    })
    .catch(() => []);
  cached = { endpoint: config.endpoint, result };
  return result;
}

/** Forget the cached list (tests). */
export function resetSwitcherCache(): void {
  cached = undefined;
}

export function sanitizeConsoles(value: unknown): SwitcherConsole[] {
  if (!Array.isArray(value)) return [];
  const out: SwitcherConsole[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.title !== 'string' || !isSafeHref(c.href)) continue;
    out.push({
      id: c.id,
      title: c.title,
      ...(typeof c.package === 'string' ? { package: c.package } : {}),
      icon: iconKey(c.icon),
      href: c.href,
    });
  }
  return out;
}

/** Search every console this viewer may open. Any failure reads as "no hits". */
export async function searchConsoles(
  config: SwitcherConfig,
  q: string,
  signal?: AbortSignal,
): Promise<SwitcherSearchGroup[]> {
  try {
    const res = await fetch(`${config.endpoint}/search?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body?.results)) return [];
    const groups: SwitcherSearchGroup[] = [];
    for (const item of body.results) {
      if (typeof item !== 'object' || item === null) continue;
      const g = item as Record<string, unknown>;
      if (typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits))
        continue;
      const hits = g.hits
        .filter(
          (h): h is SwitcherSearchHit =>
            typeof h === 'object' &&
            h !== null &&
            typeof (h as SwitcherSearchHit).title === 'string' &&
            isSafeHref((h as SwitcherSearchHit).href),
        )
        .map((h) => ({
          title: h.title,
          ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
          href: h.href,
        }));
      if (hits.length > 0) groups.push({ id: g.id, title: g.title, icon: iconKey(g.icon), hits });
    }
    return groups;
  } catch {
    return [];
  }
}

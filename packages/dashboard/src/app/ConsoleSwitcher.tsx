import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  loadConsoles,
  type SwitcherConfig,
  type SwitcherConsole,
  type SwitcherSearchGroup,
  searchConsoles,
} from '../client/console-switcher';
import { ConsoleIcon } from './console-switcher-icons';

interface CurrentConsole {
  title: string;
  package?: string;
}

/**
 * The console brand, turned into a switcher to the other Agora consoles this viewer may open. With
 * no config (no other console registered) or an empty list it renders the plain brand and makes no
 * request. The list is fetched once, after first paint. Ctrl/Cmd-K opens a search across them.
 */
export function ConsoleSwitcher({
  brand,
  current,
  config,
}: {
  brand: ReactNode;
  current: CurrentConsole;
  config: SwitcherConfig | undefined;
}) {
  const [consoles, setConsoles] = useState<SwitcherConsole[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (!config) return;
    let live = true;
    void loadConsoles(config).then((list) => {
      if (live) setConsoles(list);
    });
    return () => {
      live = false;
    };
  }, [config]);

  const enabled = config !== undefined && consoles.length > 0;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // Opening the menu focuses its first item.
  useEffect(() => {
    if (open) items.current.find((el) => el !== null)?.focus();
  }, [open]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(false);
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  if (!enabled) return <>{brand}</>;

  const focusItem = (index: number) => {
    const list = items.current.filter((el): el is HTMLElement => el !== null);
    if (list.length === 0) return;
    list[(index + list.length) % list.length]?.focus();
  };
  const focusedIndex = () =>
    items.current.filter((el) => el !== null).indexOf(document.activeElement as HTMLElement);

  const openMenu = () => setOpen(true);

  const onMenuKey = (event: React.KeyboardEvent) => {
    const at = focusedIndex();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(at + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(-1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  items.current = [];
  return (
    <div ref={root} className="relative" data-agora-switcher="">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current.title}: switch console`}
        className="flex items-center gap-1.5 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {brand}
        <svg
          viewBox="0 0 24 24"
          width={12}
          height={12}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="text-muted-foreground"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Consoles"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="fixed inset-x-0 top-[52px] z-50 border-y border-line bg-panel-2 p-1 sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:w-60 sm:rounded-md sm:border"
        >
          <div
            role="menuitem"
            aria-current="page"
            aria-disabled="true"
            tabIndex={-1}
            ref={(el) => {
              items.current.push(el);
            }}
            className="flex items-center gap-2.5 rounded px-2 py-1.5 text-sm text-foreground focus:bg-panel focus:outline-none"
          >
            <ConsoleIcon icon="workflow" className="text-brand" />
            <ConsoleLabel title={current.title} pkg={current.package} />
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="ml-auto text-brand"
              aria-hidden="true"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          </div>
          {consoles.map((c) => (
            <a
              key={c.id}
              role="menuitem"
              href={c.href}
              tabIndex={-1}
              ref={(el) => {
                items.current.push(el);
              }}
              className="flex items-center gap-2.5 rounded px-2 py-1.5 text-sm text-foreground hover:bg-panel focus:bg-panel focus:outline-none"
            >
              <ConsoleIcon icon={c.icon} className="text-muted-foreground" />
              <ConsoleLabel title={c.title} pkg={c.package} />
            </a>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            ref={(el) => {
              items.current.push(el);
            }}
            onClick={() => {
              setOpen(false);
              setSearching(true);
            }}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-panel focus:bg-panel focus:outline-none"
          >
            <svg
              viewBox="0 0 24 24"
              width={16}
              height={16}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-4.2-4.2" />
            </svg>
            Search all consoles
            <kbd className="mono ml-auto text-[10px] text-muted-foreground">⌘K</kbd>
          </button>
        </div>
      )}
      {searching && config && (
        <ConsoleSearch
          config={config}
          onClose={() => {
            setSearching(false);
            button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function ConsoleLabel({ title, pkg }: { title: string; pkg: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate">{title}</span>
      {pkg && <span className="mono truncate text-[10px] text-muted-foreground">{pkg}</span>}
    </span>
  );
}

/** Ctrl/Cmd-K: one query across every console the viewer may open, grouped by console. */
export function ConsoleSearch({
  config,
  onClose,
}: {
  config: SwitcherConfig;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<SwitcherSearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);

  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // A click outside the panel closes it.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  useEffect(() => {
    const query = q.trim();
    if (query === '') {
      setGroups([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void searchConsoles(config, query, controller.signal).then((found) => {
        if (controller.signal.aborted) return;
        setGroups(found);
        setLoading(false);
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, config]);

  const links = () => Array.from(results.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
  const move = (delta: number) => {
    const list = links();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLAnchorElement);
    const next = at === -1 ? (delta > 0 ? 0 : list.length - 1) : at + delta;
    if (next < 0) input.current?.focus();
    else list[Math.min(next, list.length - 1)]?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search all consoles"
        className="w-full max-w-lg overflow-hidden rounded-md border border-line bg-panel-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search runs, payments, users…"
          aria-label="Search all consoles"
          className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div ref={results} className="max-h-[60vh] overflow-y-auto p-1">
          {q.trim() !== '' && !loading && groups.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">Nothing found.</p>
          )}
          {groups.map((group) => (
            <section key={group.id} aria-label={group.title} className="py-1">
              <h3 className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                <ConsoleIcon icon={group.icon} className="h-3 w-3" />
                {group.title}
              </h3>
              {group.hits.map((hit) => (
                <a
                  key={hit.href}
                  href={hit.href}
                  onClick={onClose}
                  className="flex flex-col rounded px-2 py-1.5 text-sm text-foreground hover:bg-panel focus:bg-panel focus:outline-none"
                >
                  <span className="mono truncate">{hit.title}</span>
                  {hit.subtitle && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {hit.subtitle}
                    </span>
                  )}
                </a>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

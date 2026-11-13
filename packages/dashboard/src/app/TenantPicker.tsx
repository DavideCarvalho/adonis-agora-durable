import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../agora-kit/ui/popover';
import { durableClient, selectedTenant, type TenantPicker } from '../client/durable-client';

/** Put the picked organization in the URL (`?tenant=`, absent = all), keeping the hash route. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
}

/** The label of the picked organization (or "All organizations"). */
export function tenantLabel(picker: TenantPicker | undefined, id: string | undefined): string {
  if (id === undefined) return 'All organizations';
  return picker?.tenants.find((t) => t.id === id)?.label ?? id;
}

/** The picker data, shared by the header control and the run rows' organization chip. */
export function useTenantPicker(): TenantPicker | undefined {
  const { data } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => durableClient.tenants(),
    staleTime: 60_000,
    refetchInterval: false,
  });
  return data;
}

/**
 * The header's "Organization" control (tenancy on): a fixed chip for one organization, a searchable
 * list for several ("All organizations" first when the viewer may see every one). Nothing when
 * tenancy is off.
 */
export function TenantPickerControl() {
  const picker = useTenantPicker();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const current = selectedTenant();

  if (!picker || picker.mode === 'off') return null;

  const chip =
    'mono flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-fg-2';

  if (picker.mode === 'none') {
    return (
      <span className={chip} title="Choose an organization in the app to see its runs">
        <span className="text-dim">Organization</span> none
      </span>
    );
  }
  if (picker.mode === 'fixed') {
    return (
      <span className={chip} data-tenant-picker="fixed">
        <span className="text-dim">Organization</span>
        {picker.tenants[0]?.label ?? picker.tenants[0]?.id}
      </span>
    );
  }

  const choose = async (tenant: string | undefined) => {
    setOpen(false);
    setSearch('');
    await durableClient.selectTenant(tenant ?? '*').catch(() => undefined);
    writeTenantToUrl(tenant);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
  };
  const needle = search.trim().toLowerCase();
  const shown = picker.tenants.filter(
    (t) =>
      needle === '' ||
      t.label.toLowerCase().includes(needle) ||
      t.id.toLowerCase().includes(needle),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`${chip} hover:border-line-strong`}
        aria-label="Organization"
        data-tenant-picker="pick"
      >
        <span className="text-dim">Organization</span>
        {tenantLabel(picker, current)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search organizations…"
          aria-label="search organizations"
          className="mb-1 w-full rounded border border-line bg-transparent px-2 py-1 text-xs text-fg outline-none"
        />
        <div role="listbox" aria-label="Organizations" className="max-h-72 overflow-y-auto">
          {picker.all && (
            <button
              type="button"
              role="option"
              aria-selected={current === undefined}
              onClick={() => void choose(undefined)}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-panel"
            >
              All organizations
            </button>
          )}
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={current === t.id}
              onClick={() => void choose(t.id)}
              className="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-panel"
            >
              <span className="truncate">{t.label}</span>
              {t.label !== t.id && (
                <span className="mono truncate text-[10px] text-dim">{t.id}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-dim">No match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

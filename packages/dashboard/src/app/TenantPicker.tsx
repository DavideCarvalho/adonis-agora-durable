import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { durableClient, selectedTenant, type TenantPicker } from '../client/durable-client';
import { usePageSearch } from './AppPicker';

/** Put the picked organization in the URL (`?tenant=`, absent = all), keeping the hash route. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: tell the router and the URL-state adapter the URL moved.
  window.dispatchEvent(new PopStateEvent('popstate'));
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

const TENANT_TEXT = {
  noun: 'Organization',
  all: 'All organizations',
  some: 'Every organization you can see',
  search: 'Search organizations',
  empty: 'No organizations.',
};

/**
 * The header's "Organization" control (tenancy on), in the kit's look: a fixed chip for one
 * organization (or "none"), a searchable `ScopeMenu` for several ("All organizations" first when
 * the viewer may see every one). Nothing when tenancy is off.
 */
export function TenantPickerControl() {
  const picker = useTenantPicker();
  const queryClient = useQueryClient();
  usePageSearch();
  const current = selectedTenant();

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none' || picker.mode === 'fixed') {
    const only = picker.mode === 'fixed' ? picker.tenants[0] : undefined;
    return <ScopeChip noun={TENANT_TEXT.noun} label={only ? only.label : 'none'} kind="tenant" />;
  }

  const choose = async (tenant: string | undefined) => {
    await durableClient.selectTenant(tenant ?? '*').catch(() => undefined);
    writeTenantToUrl(tenant);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
  };

  return (
    <ScopeMenu
      items={picker.tenants}
      all={picker.all}
      current={current}
      text={TENANT_TEXT}
      labelOf={(id) => tenantLabel(picker, id)}
      onChoose={(next) => void choose(next)}
    />
  );
}

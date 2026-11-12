import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../src/index.js';
import type { RunGateway, StartRunOptions } from '../../src/run-gateway/interface.js';
import { tenantScopedGateway } from '../../src/run-gateway/tenant-scoped-gateway.js';
import type { EngineTenancy, RunTenantFilter } from '../../src/tenancy.js';

const at = new Date('2026-11-12T00:00:00.000Z');
const run = (id: string, tenantId?: string): WorkflowRun => ({
  id,
  workflow: 'w',
  workflowVersion: '1',
  status: 'suspended',
  input: {},
  createdAt: at,
  updatedAt: at,
  ...(tenantId ? { tenantId } : {}),
});

function fakeGateway() {
  const runs = [run('a', 'acme'), run('g', 'globex'), run('n')];
  const started: StartRunOptions[] = [];
  const cancelled: string[] = [];
  const gateway = {
    topology: () => 'tenant',
    getRun: async (id: string) => runs.find((r) => r.id === id) ?? null,
    listRuns: async (query: { tenantIds?: Array<string | null> }) =>
      runs.filter((r) => !query.tenantIds || query.tenantIds.includes(r.tenantId ?? null)),
    getCheckpoints: async () => [],
    getRunChildren: async () => [],
    getSearchAttributes: async () => undefined,
    workerHealth: async () => [],
    start: async (_w: unknown, _i: unknown, opts?: StartRunOptions) => {
      started.push(opts ?? {});
      return { runId: 'new', status: 'pending' };
    },
    signal: async () => null,
    cancel: async (id: string) => {
      cancelled.push(id);
      return { runId: id, status: 'cancelled' };
    },
    redispatchPending: async () => null,
    subscribe: () => () => undefined,
  } as unknown as RunGateway;
  return { gateway, started, cancelled };
}

const tenancy = (filter: RunTenantFilter): EngineTenancy => ({
  filter: () => filter,
  run: (_t, fn) => fn(),
  nullRows: 'tenantless',
});

describe('tenantScopedGateway (a tenant pod)', () => {
  it('stamps the active tenant on starts; an explicit tenantId wins', async () => {
    const { gateway, started } = fakeGateway();
    const scoped = tenantScopedGateway(
      gateway,
      tenancy({ mode: 'tenant', tenant: { id: 'acme', kind: 'organization' } }),
    );
    await scoped.start('w', {});
    await scoped.start('w', {}, { tenantId: null });
    expect(started).toEqual([{ tenantId: 'acme', tenantKind: 'organization' }, { tenantId: null }]);
  });

  it("narrows reads and refuses actions on another tenant's runs", async () => {
    const { gateway, cancelled } = fakeGateway();
    const scoped = tenantScopedGateway(
      gateway,
      tenancy({ mode: 'tenant', tenant: { id: 'acme' } }),
    );
    expect((await scoped.listRuns({})).map((r) => r.id)).toEqual(['a']);
    expect(await scoped.getRun('g')).toBeNull();
    expect(await scoped.cancel('g')).toBeNull();
    expect(await scoped.cancel('a')).not.toBeNull();
    expect(cancelled).toEqual(['a']);
  });

  it('passes everything through with no tenant context (system)', async () => {
    const { gateway } = fakeGateway();
    const scoped = tenantScopedGateway(gateway, tenancy({ mode: 'system' }));
    expect((await scoped.listRuns({})).length).toBe(3);
    expect(await scoped.getRun('g')).not.toBeNull();
  });
});

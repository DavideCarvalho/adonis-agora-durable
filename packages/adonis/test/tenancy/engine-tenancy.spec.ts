import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';
import { trustedCustomerTenant } from '../../src/run-gateway/run-request-responder.js';
import { contextEngineTenancy, type DurableTenancyOption, runVisible } from '../../src/tenancy.js';

/**
 * A stand-in for @adonis-agora/context's tenancy slot (Symbol.for('@agora/context:tenancy') v1): an
 * ALS store holding the tenant, the same shapes and modes the real slot answers.
 */
type Store = { tenant?: { id: string; kind: string }; all?: boolean };
const als = new AsyncLocalStorage<Store>();
const SLOT = Symbol.for('@agora/context:tenancy');
let enabled = true;
const slot = {
  version: 1,
  tenancy: () => ({ enabled }),
  tenantFilter: (options?: { kinds?: string[] }) => {
    const store = als.getStore();
    if (!store) return { mode: 'system' };
    if (store.all) return { mode: 'all' };
    if (store.tenant && (!options?.kinds || options.kinds.includes(store.tenant.kind))) {
      return { mode: 'tenant', tenant: { ...store.tenant, source: 'app' } };
    }
    return { mode: 'tenantless' };
  },
  withTenant: <T>(input: { id: string; kind: string } | null, fn: () => T): T =>
    als.run({ ...(input ? { tenant: { id: input.id, kind: input.kind } } : {}) }, fn),
  allTenants: <T>(fn: () => T): T => als.run({ all: true }, fn),
};

const asTenant = <T>(id: string, fn: () => T, kind = 'organization') =>
  als.run({ tenant: { id, kind } }, fn);
const tenantless = <T>(fn: () => T) => als.run({}, fn);
const allTenants = <T>(fn: () => T) => als.run({ all: true }, fn);

function makeEngine(option?: DurableTenancyOption) {
  const seenTenant: Array<string | undefined> = [];
  const engine = new WorkflowEngine({
    store: new InMemoryStateStore(),
    transport: new InMemoryTransport(),
    tenancy: contextEngineTenancy(option),
  });
  engine.register('greet', '1', async () => 'hi');
  engine.register('waiter', '1', async (ctx) => {
    await ctx.waitForSignal('go');
    // The tenant the resumed turn runs under (no request around it: the signal comes from "system").
    const filter = slot.tenantFilter();
    seenTenant.push(
      filter.mode === 'tenant' ? (filter as { tenant: { id: string } }).tenant.id : filter.mode,
    );
    return 'done';
  });
  engine.register('parent', '1', async (ctx) => {
    return ctx.child('greet', {}, { id: `${ctx.runId}:child` } as never);
  });
  return { engine, seenTenant };
}

beforeEach(() => {
  enabled = true;
  (globalThis as Record<symbol, unknown>)[SLOT] = slot;
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

describe('tenancy off', () => {
  it('stamps nothing and filters nothing when context has tenancy disabled', async () => {
    enabled = false;
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('greet', {}, 'r1'));
    await engine.waitForRun('r1');
    expect((await engine.getRun('r1'))?.tenantId).toBeUndefined();
    expect(await asTenant('other', () => engine.getRun('r1'))).not.toBeNull();
  });

  it('stamps nothing without context installed', async () => {
    delete (globalThis as Record<symbol, unknown>)[SLOT];
    const { engine } = makeEngine();
    await engine.start('greet', {}, 'r1');
    expect((await engine.getRun('r1'))?.tenantId).toBeUndefined();
  });

  it('tenancy: false opts out even when context enables it', async () => {
    const { engine } = makeEngine(false);
    await asTenant('acme', () => engine.start('greet', {}, 'r1'));
    expect((await engine.getRun('r1'))?.tenantId).toBeUndefined();
  });
});

describe('tenancy on', () => {
  it('stamps the active tenant; the explicit option wins; null means none', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('greet', {}, 'a'));
    await asTenant('acme', () =>
      engine.start('greet', {}, 'b', { tenantId: 'globex', tenantKind: 'organization' }),
    );
    await asTenant('acme', () => engine.start('greet', {}, 'c', { tenantId: null }));
    await tenantless(() => engine.start('greet', {}, 'd'));
    const read = (id: string) => allTenants(() => engine.getRun(id));
    expect(await read('a')).toMatchObject({ tenantId: 'acme', tenantKind: 'organization' });
    expect((await read('b'))?.tenantId).toBe('globex');
    expect((await read('c'))?.tenantId).toBeUndefined();
    expect((await read('d'))?.tenantId).toBeUndefined();
  });

  it('applies the matching rule to reads (not-found, never forbidden)', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('greet', {}, 'a'));
    await asTenant('globex', () => engine.start('greet', {}, 'g'));
    await tenantless(() => engine.start('greet', {}, 'n'));
    for (const id of ['a', 'g', 'n']) await engine.waitForRun(id);

    expect(await asTenant('acme', () => engine.getRun('a'))).not.toBeNull();
    expect(await asTenant('acme', () => engine.getRun('g'))).toBeNull();
    expect(await asTenant('acme', () => engine.getRun('n'))).toBeNull();
    expect(await tenantless(() => engine.getRun('n'))).not.toBeNull();
    expect(await tenantless(() => engine.getRun('a'))).toBeNull();
    expect(await allTenants(() => engine.getRun('g'))).not.toBeNull();
    // No context at all (a worker, recovery): no filtering.
    expect(await engine.getRun('g')).not.toBeNull();

    const ids = async (fn: () => Promise<Array<{ id: string }>>) =>
      (await fn()).map((r) => r.id).sort();
    expect(await ids(() => asTenant('acme', () => engine.listRuns({})))).toEqual(['a']);
    expect(await ids(() => tenantless(() => engine.listRuns({})))).toEqual(['n']);
    expect(await ids(() => allTenants(() => engine.listRuns({})))).toEqual(['a', 'g', 'n']);
    expect(await asTenant('acme', () => engine.countRuns({}))).toBe(1);
    expect(await asTenant('acme', () => engine.listCheckpoints('g'))).toEqual([]);
    expect(await asTenant('acme', () => engine.getRunDetail('g'))).toBeNull();
  });

  it("nullRows: 'shared' lets a tenant see runs with no tenant", async () => {
    const { engine } = makeEngine({ nullRows: 'shared' });
    await tenantless(() => engine.start('greet', {}, 'n'));
    await asTenant('globex', () => engine.start('greet', {}, 'g'));
    expect(await asTenant('acme', () => engine.getRun('n'))).not.toBeNull();
    expect(await asTenant('acme', () => engine.getRun('g'))).toBeNull();
  });

  it('kinds: a tenant of another kind counts as no tenant', async () => {
    const { engine } = makeEngine({ kinds: ['clinic'] });
    await asTenant('acme', () => engine.start('greet', {}, 'a'), 'organization');
    await asTenant('c1', () => engine.start('greet', {}, 'c'), 'clinic');
    expect((await allTenants(() => engine.getRun('a')))?.tenantId).toBeUndefined();
    expect((await allTenants(() => engine.getRun('c')))?.tenantKind).toBe('clinic');
  });

  it('control calls on another tenant answer not-found and change nothing', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('waiter', {}, 'w'));
    await expect.poll(async () => (await engine.getRun('w'))?.status).toBe('suspended');
    expect(await asTenant('globex', () => engine.cancel('w'))).toBeNull();
    expect(await asTenant('globex', () => engine.requeue('w'))).toBeNull();
    expect(await asTenant('globex', () => engine.signal('go', 1))).toBeNull();
    expect(await asTenant('globex', () => engine.continue('w'))).toBeNull();
    expect((await engine.getRun('w'))?.status).toBe('suspended');
  });

  it("restores the run's tenant on a resume that has no request around it", async () => {
    const { engine, seenTenant } = makeEngine();
    await asTenant('acme', () => engine.start('waiter', {}, 'w'));
    await expect.poll(async () => (await engine.getRun('w'))?.status).toBe('suspended');
    // The signal arrives from a worker / webhook with no context.
    await engine.signal('go', undefined);
    await engine.waitForRun('w');
    expect(seenTenant).toEqual(['acme']);
  });

  it('child runs inherit the parent tenant', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('parent', {}, 'p'));
    await engine.waitForRun('p');
    const children = await engine.listRuns({ workflow: 'greet' });
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((r) => r.tenantId === 'acme')).toBe(true);
  });

  it('retryWithInput keeps the tenant', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('greet', {}, 'a'));
    await engine.waitForRun('a');
    const retried = await engine.retryWithInput('a', {});
    expect((await engine.getRun(retried?.runId ?? ''))?.tenantId).toBe('acme');
  });

  it('a start colliding with another tenant run id does not reveal it', async () => {
    const { engine } = makeEngine();
    await asTenant('acme', () => engine.start('greet', {}, 'same'));
    await expect(asTenant('globex', () => engine.start('greet', {}, 'same'))).rejects.toThrow(
      'already exists',
    );
  });

  it('tenancy.namespace routes a tenant to its own pool', async () => {
    const { engine } = makeEngine({ namespace: (t) => `pool-${t.id}` });
    await asTenant('acme', () => engine.start('greet', {}, 'a', { startAt: Date.now() + 60_000 }));
    expect((await engine.getRun('a'))?.namespace).toBe('pool-acme');
  });

  it('persisted schedules keep the tenant they were created under, and fires carry it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      tenancy: contextEngineTenancy(undefined),
      persistedSchedules: true,
    });
    engine.register('greet', '1', async () => 'hi');
    await asTenant('acme', () =>
      engine.schedules.create({ id: 's1', workflow: 'greet', every: 60_000 }),
    );
    expect((await store.getSchedule('s1'))?.tenantId).toBe('acme');
    expect(await asTenant('globex', () => engine.schedules.get('s1'))).toBeNull();
    expect(await asTenant('globex', () => engine.schedules.list())).toEqual([]);
    const fired = await asTenant('acme', () => engine.schedules.trigger('s1'));
    expect((await engine.getRun(fired.runId))?.tenantId).toBe('acme');
  });
});

describe('helpers', () => {
  it('runVisible implements the matrix', () => {
    const t = { mode: 'tenant' as const, tenant: { id: 'a' } };
    expect(runVisible(t, { tenantId: 'a' }, 'tenantless')).toBe(true);
    expect(runVisible(t, { tenantId: 'b' }, 'tenantless')).toBe(false);
    expect(runVisible(t, {}, 'tenantless')).toBe(false);
    expect(runVisible(t, {}, 'shared')).toBe(true);
    expect(runVisible({ mode: 'tenantless' }, {}, 'tenantless')).toBe(true);
    expect(runVisible({ mode: 'tenantless' }, { tenantId: 'a' }, 'shared')).toBe(false);
    expect(runVisible({ mode: 'all' }, { tenantId: 'a' }, 'tenantless')).toBe(true);
    expect(runVisible({ mode: 'system' }, { tenantId: 'a' }, 'tenantless')).toBe(true);
  });

  it('a pod-claimed customer tenant is kept only with a capability', () => {
    expect(trustedCustomerTenant('acme', [])).toBeNull();
    expect(trustedCustomerTenant('acme', undefined)).toBeNull();
    expect(trustedCustomerTenant('acme', ['tenancy:*'])).toBe('acme');
    expect(trustedCustomerTenant('acme', ['tenancy:acme'])).toBe('acme');
    expect(trustedCustomerTenant('acme', ['tenancy:globex'])).toBeNull();
    expect(trustedCustomerTenant(undefined, ['tenancy:*'])).toBeNull();
  });
});

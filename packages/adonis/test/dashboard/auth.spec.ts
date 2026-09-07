import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAuthorize, resolveConfig } from '../../src/dashboard/define_config.js';

/** Minimal HttpContext stand-in exposing the bits the guard reads. */
function fakeCtx(
  opts: { headers?: Record<string, string>; qs?: Record<string, string>; method?: string } = {},
): HttpContext {
  const headers = opts.headers ?? {};
  return {
    request: {
      header: (name: string) => headers[name.toLowerCase()],
      qs: () => opts.qs ?? {},
      method: () => opts.method ?? 'GET',
    },
  } as unknown as HttpContext;
}

const NODE_ENV = process.env.NODE_ENV;
const TOKEN = process.env.DURABLE_DASHBOARD_TOKEN;

/** Set an env var to a string value, or remove it entirely when `undefined`. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

describe('defaultAuthorize — fails closed in EVERY environment', () => {
  beforeEach(() => {
    setEnv('DURABLE_DASHBOARD_TOKEN', undefined);
  });
  afterEach(() => {
    setEnv('NODE_ENV', NODE_ENV);
    setEnv('DURABLE_DASHBOARD_TOKEN', TOKEN);
  });

  it('denies OUTSIDE production too when no token is configured (the old open default)', () => {
    process.env.NODE_ENV = 'development';
    expect(defaultAuthorize(fakeCtx())).toBe(false);
  });

  it('denies with NODE_ENV unset / misspelled — the deployments the old branch left open', () => {
    setEnv('NODE_ENV', undefined);
    expect(defaultAuthorize(fakeCtx())).toBe(false);
    process.env.NODE_ENV = 'prod';
    expect(defaultAuthorize(fakeCtx())).toBe(false);
  });

  it('denies when no token env is configured (fail-closed)', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = '';
    expect(defaultAuthorize(fakeCtx())).toBe(false);
  });

  it('denies with a wrong token', () => {
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer nope' } }))).toBe(false);
  });

  it('allows with a matching bearer token, in any environment', () => {
    process.env.NODE_ENV = 'development';
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer secret' } }))).toBe(true);
  });

  it('accepts the token via the x-durable-token header', () => {
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { 'x-durable-token': 'secret' } }))).toBe(true);
  });

  it('accepts the ?token query param on GET only (EventSource), never on a mutating method', () => {
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ qs: { token: 'secret' } }))).toBe(true);
    expect(defaultAuthorize(fakeCtx({ qs: { token: 'secret' }, method: 'POST' }))).toBe(false);
    // The header channels still work for mutating methods.
    expect(
      defaultAuthorize(fakeCtx({ headers: { 'x-durable-token': 'secret' }, method: 'POST' })),
    ).toBe(true);
  });
});

describe('resolveConfig', () => {
  afterEach(() => {
    setEnv('DURABLE_DASHBOARD_TOKEN', TOKEN);
  });

  it('applies defaults', () => {
    const c = resolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.path).toBe('/durable');
    expect(typeof c.authorize).toBe('function');
  });

  it('the default guard is the fail-closed token guard (denies with no token env)', async () => {
    setEnv('DURABLE_DASHBOARD_TOKEN', undefined);
    const c = resolveConfig();
    expect(await c.authorize(fakeCtx())).toBe(false);
  });

  it('allowUnauthenticated: true consciously opens the guard', async () => {
    setEnv('DURABLE_DASHBOARD_TOKEN', undefined);
    const c = resolveConfig({ allowUnauthenticated: true });
    expect(await c.authorize(fakeCtx())).toBe(true);
  });

  it('a configured dashboardAuth makes the session guard the gate (authorize passes)', async () => {
    setEnv('DURABLE_DASHBOARD_TOKEN', undefined);
    const c = resolveConfig({
      dashboardAuth: { secret: 's3cret-key', login: () => ({ id: 'u1' }) },
    });
    // authorize alone passes — enforce() still requires the session cookie on every route.
    expect(await c.authorize(fakeCtx())).toBe(true);
    expect(c.dashboardAuth).not.toBeNull();
  });

  it('normalizes the path (single leading slash, no trailing)', () => {
    expect(resolveConfig({ path: 'admin/durable/' }).path).toBe('/admin/durable');
    expect(resolveConfig({ path: '///ops' }).path).toBe('/ops');
  });

  it('honors a custom authorize hook (it wins over allowUnauthenticated)', async () => {
    let seen = false;
    const c = resolveConfig({
      allowUnauthenticated: true,
      authorize: () => {
        seen = true;
        return false;
      },
    });
    expect(await c.authorize({} as HttpContext)).toBe(false);
    expect(seen).toBe(true);
  });

  it('respects enabled: false', () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });
});

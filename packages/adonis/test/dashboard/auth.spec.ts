import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAuthorize, resolveConfig } from '../../src/dashboard/define_config.js';

/** Minimal HttpContext stand-in exposing the bits the guard reads. */
function fakeCtx(
  opts: { headers?: Record<string, string>; qs?: Record<string, string> } = {},
): HttpContext {
  const headers = opts.headers ?? {};
  return {
    request: {
      header: (name: string) => headers[name.toLowerCase()],
      qs: () => opts.qs ?? {},
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

describe('defaultAuthorize', () => {
  beforeEach(() => {
    setEnv('DURABLE_DASHBOARD_TOKEN', undefined);
  });
  afterEach(() => {
    setEnv('NODE_ENV', NODE_ENV);
    setEnv('DURABLE_DASHBOARD_TOKEN', TOKEN);
  });

  it('allows everything outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(defaultAuthorize(fakeCtx())).toBe(true);
  });

  it('denies in production when no token is configured (fail-closed)', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = '';
    expect(defaultAuthorize(fakeCtx())).toBe(false);
  });

  it('denies in production with a wrong token', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer nope' } }))).toBe(false);
  });

  it('allows in production with a matching bearer token', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { authorization: 'Bearer secret' } }))).toBe(true);
  });

  it('accepts the token via the x-durable-token header', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ headers: { 'x-durable-token': 'secret' } }))).toBe(true);
  });

  it('accepts the token via the ?token query param', () => {
    process.env.NODE_ENV = 'production';
    process.env.DURABLE_DASHBOARD_TOKEN = 'secret';
    expect(defaultAuthorize(fakeCtx({ qs: { token: 'secret' } }))).toBe(true);
  });
});

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const c = resolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.path).toBe('/durable');
    expect(typeof c.authorize).toBe('function');
  });

  it('normalizes the path (single leading slash, no trailing)', () => {
    expect(resolveConfig({ path: 'admin/durable/' }).path).toBe('/admin/durable');
    expect(resolveConfig({ path: '///ops' }).path).toBe('/ops');
  });

  it('honors a custom authorize hook', async () => {
    let seen = false;
    const c = resolveConfig({
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

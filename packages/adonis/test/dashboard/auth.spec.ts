import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { authorizeByToken } from '../../src/dashboard/console_authorize.js';
import { NO_AUTHORIZE_WARNING, resolveConfig } from '../../src/dashboard/define_config.js';

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

describe('resolveConfig — authorize omitted', () => {
  it('applies defaults', () => {
    const c = resolveConfig();
    expect(c.enabled).toBe(true);
    expect(c.path).toBe('/durable');
    expect(typeof c.authorize).toBe('function');
    expect(c.authorizeConfigured).toBe(false);
  });

  it('is open outside production', async () => {
    const c = resolveConfig({}, { inProduction: false });
    expect(await c.authorize(fakeCtx())).toEqual({ allowed: true });
  });

  it('denies every request in production (403)', async () => {
    const c = resolveConfig({}, { inProduction: true });
    expect(await c.authorize(fakeCtx())).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('denies when the environment is unknown', async () => {
    const c = resolveConfig();
    expect(await c.authorize(fakeCtx())).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('ignores the removed token channels and options', async () => {
    const c = resolveConfig(
      { allowUnauthenticated: true, dashboardAuth: { secret: 'x' } } as never,
      { inProduction: true },
    );
    for (const ctx of [
      fakeCtx({ headers: { authorization: 'Bearer secret' } }),
      fakeCtx({ headers: { 'x-durable-token': 'secret' } }),
      fakeCtx({ qs: { token: 'secret' } }),
    ]) {
      expect(await c.authorize(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    }
  });

  it('the boot warning has the shared wording', () => {
    expect(NO_AUTHORIZE_WARNING).toBe(
      '[@adonis-agora/durable] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/durable_dashboard.ts.',
    );
  });
});

describe('resolveConfig', () => {
  it('normalizes the path (single leading slash, no trailing)', () => {
    expect(resolveConfig({ path: 'admin/durable/' }).path).toBe('/admin/durable');
    expect(resolveConfig({ path: '///ops' }).path).toBe('/ops');
  });

  it('a configured authorize wins in every environment', async () => {
    for (const inProduction of [true, false]) {
      let seen = false;
      const c = resolveConfig(
        {
          authorize: () => {
            seen = true;
            return false;
          },
        },
        { inProduction },
      );
      expect(c.authorizeConfigured).toBe(true);
      expect(await c.authorize({} as HttpContext)).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
      expect(seen).toBe(true);
    }
  });

  it('respects enabled: false', () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('authorizeByToken', () => {
  const gate = authorizeByToken({ token: 'secret' });

  it('allows a matching Authorization: Bearer header', () => {
    expect(gate(fakeCtx({ headers: { authorization: 'Bearer secret' } }))).toEqual({
      allowed: true,
    });
    expect(gate(fakeCtx({ headers: { authorization: 'bearer   secret' } }))).toEqual({
      allowed: true,
    });
  });

  it('answers unauthenticated for a wrong, missing or differently-sized token', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(gate(fakeCtx({ headers: { authorization: 'Bearer nope' } }))).toEqual(denied);
    expect(gate(fakeCtx({ headers: { authorization: 'Bearer secret-and-more' } }))).toEqual(denied);
    expect(gate(fakeCtx({ headers: { authorization: 'Basic secret' } }))).toEqual(denied);
    expect(gate(fakeCtx())).toEqual(denied);
  });

  it('reads the header only (no query string, no custom header)', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(gate(fakeCtx({ qs: { token: 'secret' } }))).toEqual(denied);
    expect(gate(fakeCtx({ headers: { 'x-durable-token': 'secret' } }))).toEqual(denied);
  });

  it('throws at config time for an empty or undefined token', () => {
    expect(() => authorizeByToken({ token: undefined })).toThrow(/non-empty/);
    expect(() => authorizeByToken({ token: '' })).toThrow(/non-empty/);
  });

  it('plugs into resolveConfig as the authorize gate', async () => {
    const c = resolveConfig(
      { authorize: authorizeByToken({ token: 'secret' }) },
      { inProduction: true },
    );
    expect(await c.authorize(fakeCtx({ headers: { authorization: 'Bearer secret' } }))).toEqual({
      allowed: true,
    });
    expect(await c.authorize(fakeCtx())).toEqual({ allowed: false, reason: 'unauthenticated' });
  });
});

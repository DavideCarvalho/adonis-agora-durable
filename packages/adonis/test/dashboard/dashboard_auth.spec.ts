import { describe, expect, it, vi } from 'vitest';
import {
  type ResolvedDashboardAuth,
  performLogin,
  performSession,
  readSession,
  resolveDashboardAuth,
  sanitizeReturnTo,
} from '../../src/dashboard/auth.js';
import { signSessionCookie, verifySessionCookie } from '../../src/dashboard/session_cookie.js';

const SECRET = 'controller-spec-secret-key-0123456789';
const BASE_PATH = '/durable';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is not configured (absent-option)', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('resolves a valid config with the default 8h ttl', () => {
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 'x'.repeat(32), login });
    expect(resolved).toEqual({
      secret: 'x'.repeat(32),
      ttlMs: 8 * 60 * 60 * 1000,
      modes: ['login'],
      login,
    });
  });

  it('resolves Mode A (session) alone, and both modes together', () => {
    const session = () => null;
    const login = () => null;
    expect(resolveDashboardAuth({ secret: 's', session })?.modes).toEqual(['session']);
    expect(resolveDashboardAuth({ secret: 's', session, login })?.modes).toEqual([
      'session',
      'login',
    ]);
  });

  it('parses a custom ttl string', () => {
    const resolved = resolveDashboardAuth({ secret: 's', ttl: '30m', login: () => null });
    expect(resolved?.ttlMs).toBe(30 * 60 * 1000);
  });

  it('falls back to the 8h default on a malformed ttl', () => {
    const resolved = resolveDashboardAuth({
      secret: 's',
      ttl: 'not-a-duration',
      login: () => null,
    });
    expect(resolved?.ttlMs).toBe(8 * 60 * 60 * 1000);
  });

  it('throws (fail closed) when secret is missing', () => {
    expect(() => resolveDashboardAuth({ secret: '', login: () => null })).toThrow(
      /secret is required/,
    );
  });

  it('throws (fail closed) when neither login nor session is configured', () => {
    expect(() => resolveDashboardAuth({ secret: 's' })).toThrow(
      /needs at least one of `login` or `session`/,
    );
  });
});

describe('sanitizeReturnTo (open-redirect guard)', () => {
  it('keeps a same-origin, root-relative path', () => {
    expect(sanitizeReturnTo('/durable/runs/1', BASE_PATH)).toBe('/durable/runs/1');
  });

  it('rejects protocol-relative, absolute, and non-string targets', () => {
    expect(sanitizeReturnTo('//evil.example', BASE_PATH)).toBe(BASE_PATH);
    expect(sanitizeReturnTo('https://evil.example/phish', BASE_PATH)).toBe(BASE_PATH);
    expect(sanitizeReturnTo('runs/1', BASE_PATH)).toBe(BASE_PATH);
    expect(sanitizeReturnTo(undefined, BASE_PATH)).toBe(BASE_PATH);
    expect(sanitizeReturnTo(42, BASE_PATH)).toBe(BASE_PATH);
  });
});

describe('performLogin', () => {
  const auth = resolveDashboardAuth({
    secret: SECRET,
    login: (username, password) =>
      username === 'ops' && password === 'correct-horse' ? { id: 'ops', roles: ['admin'] } : null,
  }) as ResolvedDashboardAuth;

  it('mints a cookie the session verifier accepts on a successful login', async () => {
    const outcome = await performLogin(
      auth,
      { username: 'ops', password: 'correct-horse', returnTo: '/durable/runs/1' },
      BASE_PATH,
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.redirectTo).toBe('/durable/runs/1');
    const session = verifySessionCookie(outcome.cookieValue, { secret: SECRET });
    expect(session).toMatchObject({ sub: 'ops', roles: ['admin'] });
  });

  it('sanitizes an unsafe returnTo to basePath (open-redirect guard)', async () => {
    const outcome = await performLogin(
      auth,
      { username: 'ops', password: 'correct-horse', returnTo: 'https://evil.example/phish' },
      BASE_PATH,
    );
    expect(outcome).toMatchObject({ kind: 'ok', redirectTo: BASE_PATH });
  });

  it('returns bad-request when username/password are not strings', async () => {
    const outcome = await performLogin(auth, { username: 'ops' }, BASE_PATH);
    expect(outcome.kind).toBe('bad-request');
  });

  it('uniform failure: unknown user and wrong password get the same 401 message', async () => {
    const unknown = await performLogin(auth, { username: 'nobody', password: 'x' }, BASE_PATH);
    const wrong = await performLogin(auth, { username: 'ops', password: 'wrong' }, BASE_PATH);
    expect(unknown.kind).toBe('unauthorized');
    expect(wrong.kind).toBe('unauthorized');
    if (unknown.kind !== 'unauthorized' || wrong.kind !== 'unauthorized') return;
    expect(unknown.message).toBe(wrong.message);
    // No hook error surfaced for an ordinary denial.
    expect(unknown.hookError).toBeUndefined();
  });

  it('treats a throwing login hook as a denial (unauthorized, hookError surfaced, not thrown)', async () => {
    const throwing = resolveDashboardAuth({
      secret: SECRET,
      login: () => {
        throw new Error('db is down');
      },
    }) as ResolvedDashboardAuth;
    const outcome = await performLogin(throwing, { username: 'ops', password: 'x' }, BASE_PATH);
    expect(outcome.kind).toBe('unauthorized');
    if (outcome.kind !== 'unauthorized') return;
    expect(outcome.hookError).toBeInstanceOf(Error);
  });

  it('forwards an empty password to the hook verbatim (password is optional)', async () => {
    const loginSpy = vi.fn().mockReturnValue(null);
    const spyAuth = resolveDashboardAuth({
      secret: SECRET,
      login: loginSpy,
    }) as ResolvedDashboardAuth;
    await performLogin(spyAuth, { username: 'ops', password: '' }, BASE_PATH);
    expect(loginSpy).toHaveBeenCalledWith('ops', '');
  });

  it('mints a session when the hook accepts an empty password (username-only gating)', async () => {
    const emailOnly = resolveDashboardAuth({
      secret: SECRET,
      login: (username) => (username === 'admin@example.com' ? { id: 'admin' } : null),
    }) as ResolvedDashboardAuth;
    const outcome = await performLogin(
      emailOnly,
      { username: 'admin@example.com', password: '' },
      BASE_PATH,
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(verifySessionCookie(outcome.cookieValue, { secret: SECRET })).toMatchObject({
      sub: 'admin',
    });
  });
});

describe('performSession (Mode A — host-app SSO)', () => {
  it('mints a cookie when the session hook accepts the raw request', async () => {
    const auth = resolveDashboardAuth({
      secret: SECRET,
      session: (request) => ((request as { isAdmin?: boolean }).isAdmin ? { id: 'ops' } : null),
    }) as ResolvedDashboardAuth;

    const outcome = await performSession(auth, { isAdmin: true });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(verifySessionCookie(outcome.cookieValue, { secret: SECRET })).toMatchObject({
      sub: 'ops',
    });
  });

  it('is a uniform 401 (unauthorized) on denial or a throwing hook', async () => {
    const denies = resolveDashboardAuth({
      secret: SECRET,
      session: () => null,
    }) as ResolvedDashboardAuth;
    expect((await performSession(denies, {})).kind).toBe('unauthorized');

    const throwing = resolveDashboardAuth({
      secret: SECRET,
      session: () => {
        throw new Error('boom');
      },
    }) as ResolvedDashboardAuth;
    const outcome = await performSession(throwing, {});
    expect(outcome.kind).toBe('unauthorized');
    if (outcome.kind !== 'unauthorized') return;
    expect(outcome.hookError).toBeInstanceOf(Error);
  });

  it('404-shaped (unauthorized, no cookie) when Mode A is not configured on this auth', async () => {
    const loginOnly = resolveDashboardAuth({
      secret: SECRET,
      login: () => null,
    }) as ResolvedDashboardAuth;
    expect((await performSession(loginOnly, {})).kind).toBe('unauthorized');
  });
});

describe('readSession', () => {
  const auth = resolveDashboardAuth({
    secret: SECRET,
    login: () => null,
  }) as ResolvedDashboardAuth;

  it('returns the session for a valid cookie', () => {
    const now = Date.now();
    const cookie = signSessionCookie(
      { id: 'ops', roles: ['admin'] },
      {
        secret: SECRET,
        ttlMs: 60_000,
        now,
      },
    );
    expect(readSession(auth, cookie, now)).toMatchObject({ sub: 'ops', roles: ['admin'] });
  });

  it('returns null for an absent, empty, tampered, or expired cookie', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 1000, now });
    expect(readSession(auth, undefined)).toBeNull();
    expect(readSession(auth, '')).toBeNull();
    expect(readSession(auth, 'garbage.value')).toBeNull();
    expect(readSession(auth, cookie, now + 1000 + 30_001)).toBeNull();
  });
});

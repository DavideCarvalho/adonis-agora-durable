import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import { pickRole, resolveViewer, viewerFromUser } from '../../src/dashboard/console_shell.js';

function ctx(user: unknown, authkit?: unknown): HttpContext {
  return {
    auth: { user },
    ...(authkit === undefined ? {} : { authkit }),
    request: {},
  } as unknown as HttpContext;
}

describe('console shell viewer role', () => {
  it('shows at most one role, preferring an admin-like one', () => {
    expect(pickRole([])).toBeUndefined();
    expect(pickRole(['ops', 'support'])).toBe('ops');
    expect(pickRole(['ops', 'ADMIN', 'org_admin'])).toBe('ADMIN');
    expect(pickRole(['viewer', 'org_admin'])).toBe('org_admin');
  });

  it('reads role, roles (strings, { name } or authz { role } rows) and globalRoles', () => {
    expect(viewerFromUser({ email: 'a@x.test', role: 'ops' })?.role).toBe('ops');
    expect(
      viewerFromUser({ email: 'a@x.test', roles: [{ role: 'ADVISOR' }, { role: 'ADMIN' }] }),
    ).toEqual({ label: 'a@x.test', email: 'a@x.test', role: 'ADMIN' });
    expect(viewerFromUser({ email: 'a@x.test', roles: [{ name: 'support' }] })?.role).toBe(
      'support',
    );
    expect(viewerFromUser({ email: 'a@x.test', globalRoles: ['ADMIN'] })?.role).toBe('ADMIN');
    expect(viewerFromUser({ email: 'a@x.test', role: 'ops', globalRoles: ['ADMIN'] })?.role).toBe(
      'ADMIN',
    );
    expect(viewerFromUser({ email: 'a@x.test', roles: [null, 3, {}, ' '] })).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
  });

  it('survives a user whose role getters throw', () => {
    const user = {
      email: 'a@x.test',
      get roles(): unknown {
        throw new Error('relation not loaded');
      },
    };
    expect(viewerFromUser(user)).toEqual({ label: 'a@x.test', email: 'a@x.test' });
  });

  it('adds authkit global roles from the already-resolved identity', async () => {
    const viewer = await resolveViewer(
      ctx(
        { email: 'a@x.test', roles: [{ role: 'ADVISOR' }] },
        { identity: { globalRoles: ['ADMIN'] } },
      ),
      null,
    );
    expect(viewer).toEqual({ label: 'a@x.test', email: 'a@x.test', role: 'ADMIN' });
  });

  it('awaits authkit getIdentity() when the identity is not resolved yet', async () => {
    const authkit = {
      identity: null,
      async getIdentity() {
        return { globalRoles: ['ADMIN'] };
      },
    };
    expect((await resolveViewer(ctx({ email: 'a@x.test' }, authkit), null))?.role).toBe('ADMIN');
  });

  it('gives up on the authkit role on a throw or a slow lookup, keeping the viewer', async () => {
    const failing = {
      async getIdentity() {
        throw new Error('boom');
      },
    };
    expect(await resolveViewer(ctx({ email: 'a@x.test' }, failing), null)).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
    const slow = { getIdentity: () => new Promise(() => {}) };
    expect(await resolveViewer(ctx({ email: 'a@x.test' }, slow), null)).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
  });

  it('never consults authkit when there is no user', async () => {
    let called = false;
    const authkit = {
      async getIdentity() {
        called = true;
        return { globalRoles: ['ADMIN'] };
      },
    };
    expect(await resolveViewer(ctx(null, authkit), null)).toBeUndefined();
    expect(called).toBe(false);
  });
});

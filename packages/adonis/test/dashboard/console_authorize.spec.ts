import { Container } from '@adonisjs/core/container';
import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizer,
  normalizeConsoleDecision,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';
import { defineConfig } from '../../src/dashboard/define_config.js';

/** A container that builds `InjectedAccess` with its dependency — what `@inject()` does in an app. */
function containerWith(audit: AuditLog) {
  const container = new Container();
  container.bind(InjectedAccess, () => new InjectedAccess(audit));
  return container;
}

/** A container-backed ctx double: just what the gate touches (`containerResolver`). */
function ctxWith(container = new Container()): HttpContext {
  return { containerResolver: container.createResolver() } as unknown as HttpContext;
}

class AuditLog {
  entries: string[] = [];
}

/** Has a constructor dependency, so it can only be built by the container (a binding here). */
class InjectedAccess implements ConsoleAuthorizer {
  constructor(private audit: AuditLog) {}
  authorize() {
    this.audit.entries.push('checked');
    return { allowed: true } as const;
  }
}

class DenyAccess implements ConsoleAuthorizer {
  authorize() {
    return { allowed: false, reason: 'unauthenticated' } as const;
  }
}

describe('resolveConsoleAuthorize', () => {
  it('inline function: called with ctx, result normalized', async () => {
    const ctx = ctxWith();
    let seen: unknown;
    const gate = resolveConsoleAuthorize((c: HttpContext) => {
      seen = c;
      return false;
    });
    expect(await gate(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
    expect(seen).toBe(ctx);
    expect(await resolveConsoleAuthorize(async () => true)(ctx)).toEqual({ allowed: true });
  });

  it('class: instantiated through the container (DI) and its authorize(ctx) called', async () => {
    const audit = new AuditLog();
    const container = containerWith(audit);
    const gate = resolveConsoleAuthorize(InjectedAccess);
    expect(await gate(ctxWith(container))).toEqual({ allowed: true });
    expect(await gate(ctxWith(container))).toEqual({ allowed: true });
    expect(audit.entries).toEqual(['checked', 'checked']);
    expect(await resolveConsoleAuthorize(DenyAccess)(ctxWith())).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('lazy import: resolves the default class via the container, and imports once', async () => {
    const audit = new AuditLog();
    const container = containerWith(audit);
    let imports = 0;
    const gate = resolveConsoleAuthorize(async () => {
      imports += 1;
      return { default: InjectedAccess };
    });
    for (let i = 0; i < 3; i += 1) {
      expect(await gate(ctxWith(container))).toEqual({ allowed: true });
    }
    expect(imports).toBe(1);
    expect(audit.entries).toHaveLength(3);
  });

  it('a module object without an authorizer class is just a (denying) result', async () => {
    const gate = resolveConsoleAuthorize(async () => ({ default: () => true }));
    expect(await gate(ctxWith())).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('a throw is a 403 denial carrying the error — in every form', async () => {
    const boom = new Error('boom');
    class Throws implements ConsoleAuthorizer {
      authorize(): never {
        throw boom;
      }
    }
    const forms: unknown[] = [
      () => {
        throw boom;
      },
      () => Promise.reject(boom),
      Throws,
      async () => ({ default: Throws }),
      async () => {
        throw boom; // the lazy import itself fails
      },
    ];
    for (const form of forms) {
      expect(await resolveConsoleAuthorize(form)(ctxWith())).toEqual({
        allowed: false,
        reason: 'forbidden',
        error: boom,
      });
    }
  });

  it('a class whose container resolution fails is a 403, not a pass', async () => {
    const container = new Container();
    container.bind(InjectedAccess, () => {
      throw new Error('no audit');
    });
    const decision = await resolveConsoleAuthorize(InjectedAccess)(ctxWith(container));
    expect(decision.allowed).toBe(false);
  });

  it('rejects a non-function at config time', () => {
    expect(() => resolveConsoleAuthorize(true)).toThrow(TypeError);
  });
});

describe('normalizeConsoleDecision', () => {
  it.each([
    [true, { allowed: true }],
    [{ allowed: true }, { allowed: true }],
    [false, { allowed: false, reason: 'forbidden' }],
    [{ allowed: false }, { allowed: false, reason: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, reason: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, reason: 'unauthenticated' },
    ],
    [{ redirectTo: '/login' }, { allowed: false, reason: 'unauthenticated', redirectTo: '/login' }],
    [{ redirectTo: '' }, { allowed: false, reason: 'forbidden' }],
    ['yes', { allowed: false, reason: 'forbidden' }],
    [1, { allowed: false, reason: 'forbidden' }],
    [{}, { allowed: false, reason: 'forbidden' }],
    [{ allowed: 'true' }, { allowed: false, reason: 'forbidden' }],
    [null, { allowed: false, reason: 'forbidden' }],
    [undefined, { allowed: false, reason: 'forbidden' }],
  ])('%j -> %j', (result, expected) => {
    expect(normalizeConsoleDecision(result)).toEqual(expected);
  });
});

describe('ConsoleAuthorize typing', () => {
  it('accepts all three forms in defineConfig, with ctx contextually typed', () => {
    const forms: ConsoleAuthorize[] = [
      (ctx) => ctx.request.method() === 'GET',
      async (ctx) => ({ allowed: false, reason: ctx ? 'unauthenticated' : 'forbidden' }),
      () => ({ redirectTo: '/login' }),
      InjectedAccess,
      async () => ({ default: InjectedAccess }),
    ];
    for (const authorize of forms) defineConfig({ authorize });
    // An AuthorizeResult-returning helper (the `authorizeByRoles` shape) still fits.
    const byRoles = (_ctx: unknown): Promise<boolean | { allowed: boolean }> =>
      Promise.resolve(true);
    defineConfig({ authorize: byRoles });
    expect(forms).toHaveLength(5);
  });
});

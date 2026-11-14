import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSingleDurableCopy,
  DUPLICATE_COPY_DOCS,
  DuplicateDurableCopyError,
  type DurableCopyRegistry,
  durableCopies,
  durableCopyRegistry,
  registerDurableCopy,
  sealDurableCopies,
} from '../src/copy-guard.js';
import { checkSingleCopy } from '../src/doctor/checks.js';
import { VERSION } from '../src/index.js';

function freshRegistry(): DurableCopyRegistry {
  return { copies: new Map(), booted: false };
}

const A = {
  version: '1.0.0-rc.24',
  root: '/app/node_modules/.pnpm/@adonis-agora+durable@1.0.0-rc.24_a/node_modules/@adonis-agora/durable',
};
const B = {
  version: '1.0.0-rc.24',
  root: '/app/node_modules/.pnpm/@adonis-agora+durable@1.0.0-rc.24_b/node_modules/@adonis-agora/durable',
};

describe('durable copy guard', () => {
  it('registers this package once, keyed by its real package root', () => {
    const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    const mine = durableCopies(durableCopyRegistry()).filter((c) => c.root === root);
    expect(mine).toEqual([{ version: VERSION, root }]);
    expect(() => assertSingleDurableCopy()).not.toThrow();
  });

  it('tolerates the same copy registering twice', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    registerDurableCopy({ ...A }, registry);
    sealDurableCopies(registry);
    registerDurableCopy({ ...A }, registry);
    expect(durableCopies(registry)).toHaveLength(1);
  });

  it('throws at boot when two distinct copies registered, naming both and the docs', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    registerDurableCopy(B, registry);
    let error: unknown;
    try {
      sealDurableCopies(registry);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DuplicateDurableCopyError);
    const message = (error as Error).message;
    expect(message).toContain(A.root);
    expect(message).toContain(B.root);
    expect(message).toContain('declare the same peer dependency versions');
    expect(message).toContain(DUPLICATE_COPY_DOCS);
    expect(registry.booted).toBe(false);
  });

  it('throws when a distinct copy loads after boot', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    sealDurableCopies(registry);
    expect(() => registerDurableCopy(B, registry)).toThrow(DuplicateDurableCopyError);
  });

  it('shares one registry through globalThis', () => {
    expect(durableCopyRegistry()).toBe(
      (globalThis as Record<symbol, unknown>)[Symbol.for('@adonis-agora/durable.copies')],
    );
  });
});

describe('durable.single-copy doctor check', () => {
  it('is ok with one copy', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    expect(checkSingleCopy(registry)).toEqual({
      status: 'ok',
      message: 'One copy loaded (1.0.0-rc.24).',
    });
  });

  it('is an error with two copies, with the fix and docs', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    registerDurableCopy(B, registry);
    const result = checkSingleCopy(registry);
    expect(result.status).toBe('error');
    expect(result.message).toContain(A.root);
    expect(result.message).toContain(B.root);
    expect(result.fix).toContain('pnpm.overrides');
    expect(result.docs).toBe(DUPLICATE_COPY_DOCS);
  });

  it('is ok against the live registry in this process', () => {
    expect(checkSingleCopy().status).toBe('ok');
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Regression test for the `ECONNREFUSED 127.0.0.1:6379` boot hang that appeared in 0.15.
 *
 * ROOT CAUSE: 0.15 added `bullmq` as a HARD `dependency`. `bullmq` pins an EXACT `ioredis`
 * (e.g. `ioredis@5.11.1`), so every app installing durable got that second ioredis copy in its
 * tree — even apps that only use `transports.queue()`/`db`/`eventEmitter` and never touch the
 * bullmq transport. When two ioredis copies coexist, `@boringnode/queue`'s `redis()` adapter
 * factory checks `connection instanceof Redis` against ITS ioredis copy; the live connection
 * `@adonisjs/redis` handed it was built by the OTHER copy, so the `instanceof` is false, the
 * factory falls through to `new Redis({ host: 'localhost', port: 6379, ... })`, and the app
 * loops on `ECONNREFUSED 6379` at boot instead of reusing the configured Redis.
 *
 * FIX: `bullmq` is an OPTIONAL peer dependency, imported only lazily (via a non-literal
 * specifier) inside `createBullMQDeps` — the code path behind `transports.bullmq()`. Apps that
 * don't select the bullmq transport never install bullmq, never gain the duplicate ioredis, and
 * never hit the `instanceof` mismatch.
 *
 * These two invariants guard the fix:
 *   1. package.json keeps `bullmq` an optional peer, never a hard `dependency`.
 *   2. No commonly-loaded entry point STATICALLY reaches `bullmq` — so merely importing the
 *      provider or the main barrel can never pull it in (only `transports.bullmq()` does, lazily).
 */

/** Extracts the specifier of every `import`/`export ... from '...'` and side-effect `import '...'`. */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromClause = /\bfrom\s+['"]([^'"]+)['"]/g;
  const sideEffectImport = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const re of [fromClause, sideEffectImport]) {
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp#exec loop
    while ((match = re.exec(source))) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Resolves a relative NodeNext specifier (with a `.js` suffix) back to its `.ts` source file. */
function resolveRelative(fromFile: string, specifier: string): string {
  const candidate = resolve(dirname(fromFile), specifier);
  const asTs = candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.ts` : candidate;
  try {
    readFileSync(asTs);
    return asTs;
  } catch {
    return join(candidate, 'index.ts');
  }
}

/**
 * Walks the static import graph from `entry` (following relative specifiers only) and returns the
 * set of bare (node_modules) specifiers it reaches — reading text only, executing nothing. A
 * `await import(variable)` with a NON-literal specifier (how `createBullMQDeps` loads bullmq) is
 * invisible to this walk by design: that is precisely what "lazy, not statically imported" means.
 */
function reachableBareSpecifiers(entry: string): Set<string> {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith('.')) pending.push(resolveRelative(file, specifier));
      else bare.add(specifier);
    }
  }
  return bare;
}

describe('bullmq is an optional peer dependency, never a hard dependency', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it('is NOT listed under `dependencies` (that pin forces a duplicate ioredis on every consumer)', () => {
    expect(pkg.dependencies?.bullmq).toBeUndefined();
  });

  it('IS declared as an optional peer dependency', () => {
    expect(pkg.peerDependencies?.bullmq).toBeDefined();
    expect(pkg.peerDependenciesMeta?.bullmq?.optional).toBe(true);
  });
});

describe('bullmq is never reached by a static import from a commonly-loaded entry point', () => {
  it('the main barrel (src/index.ts) never statically reaches "bullmq"', () => {
    const bare = reachableBareSpecifiers(resolve(ROOT, 'src/index.ts'));
    expect(bare.has('bullmq')).toBe(false);
  });

  it('the provider (providers/durable_provider.ts) never statically reaches "bullmq"', () => {
    const bare = reachableBareSpecifiers(resolve(ROOT, 'providers/durable_provider.ts'));
    expect(bare.has('bullmq')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './durable-client.js';
import {
  ALL_ORIGINS,
  emptyRunsNotice,
  filterByOrigin,
  isUnknownOrigin,
  knownOrigin,
  matchesOrigin,
  type OriginFilter,
  originFacets,
  originFilterKey,
  originLabel,
  sameOriginFilter,
  unknownOriginCount,
} from './run-origin.js';

const CATALOG = '@adonis-agora/catalog-pipeline';
const AGENT = '@adonis-agora/agent';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'pipeline',
    workflowVersion: '1',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('knownOrigin / isUnknownOrigin', () => {
  it('treats an absent origin as unknown', () => {
    expect(knownOrigin(undefined)).toBeUndefined();
    expect(isUnknownOrigin(undefined)).toBe(true);
  });

  it('treats a blank or whitespace-only origin as unknown too', () => {
    // A store column that defaults to '' rather than NULL must not read as a package named nothing.
    expect(knownOrigin('')).toBeUndefined();
    expect(knownOrigin('   ')).toBeUndefined();
    expect(isUnknownOrigin('')).toBe(true);
  });

  it('returns a real origin trimmed', () => {
    expect(knownOrigin(` ${CATALOG} `)).toBe(CATALOG);
    expect(isUnknownOrigin(CATALOG)).toBe(false);
  });
});

describe('originLabel', () => {
  it('drops the npm scope so a chip is readable', () => {
    expect(originLabel(CATALOG)).toBe('catalog-pipeline');
  });

  it('leaves an unscoped package name alone', () => {
    expect(originLabel('acme-storefront')).toBe('acme-storefront');
  });

  it('says "unknown" for an absent origin — never "app", never blank', () => {
    expect(originLabel(undefined)).toBe('unknown');
    expect(originLabel('')).toBe('unknown');
  });

  it('keeps a trailing-slash oddity whole rather than rendering nothing', () => {
    expect(originLabel('@dudousxd/')).toBe('@dudousxd/');
  });
});

describe('matchesOrigin', () => {
  it('"all" matches every run, INCLUDING unattributed ones', () => {
    // The default must never hide runs — an operator who has not chosen a facet sees everything.
    expect(matchesOrigin(run({ origin: CATALOG }), ALL_ORIGINS)).toBe(true);
    expect(matchesOrigin(run({ origin: undefined }), ALL_ORIGINS)).toBe(true);
  });

  it('a concrete package matches only that package', () => {
    const filter: OriginFilter = { kind: 'origin', origin: CATALOG };
    expect(matchesOrigin(run({ origin: CATALOG }), filter)).toBe(true);
    expect(matchesOrigin(run({ origin: AGENT }), filter)).toBe(false);
  });

  it('a concrete package NEVER matches an unattributed run', () => {
    // Mirrors `RunQuery.origin`: absent matches no value. Pretending otherwise would attribute a run
    // to a library that did not declare it.
    expect(matchesOrigin(run({ origin: undefined }), { kind: 'origin', origin: CATALOG })).toBe(
      false,
    );
  });

  it('"unknown" selects exactly the unattributed runs', () => {
    expect(matchesOrigin(run({ origin: undefined }), { kind: 'unknown' })).toBe(true);
    expect(matchesOrigin(run({ origin: '' }), { kind: 'unknown' })).toBe(true);
    expect(matchesOrigin(run({ origin: CATALOG }), { kind: 'unknown' })).toBe(false);
  });
});

describe('filterByOrigin', () => {
  const runs = [
    run({ id: 'a', origin: CATALOG }),
    run({ id: 'b' }),
    run({ id: 'c', origin: AGENT }),
    run({ id: 'd' }),
  ];

  it('keeps every run under "all"', () => {
    expect(filterByOrigin(runs, ALL_ORIGINS).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('narrows to one package', () => {
    expect(filterByOrigin(runs, { kind: 'origin', origin: AGENT }).map((r) => r.id)).toEqual(['c']);
  });

  it('makes the unattributed runs reachable', () => {
    // Without this the only way to see them would be to clear the facet entirely.
    expect(filterByOrigin(runs, { kind: 'unknown' }).map((r) => r.id)).toEqual(['b', 'd']);
  });
});

describe('originFacets', () => {
  const runs = [
    run({ origin: CATALOG }),
    run({ origin: CATALOG }),
    run({ origin: AGENT }),
    run({}),
    run({ origin: '' }),
  ];

  it('counts every bucket, with "all" over the whole list', () => {
    expect(originFacets(runs).map((f) => [f.label, f.count])).toEqual([
      ['all', 5],
      ['agent', 1],
      ['catalog-pipeline', 2],
      ['unknown', 2],
    ]);
  });

  it('orders all → packages (alphabetical) → unknown last', () => {
    const kinds = originFacets(runs).map((f) => f.filter.kind);
    expect(kinds).toEqual(['all', 'origin', 'origin', 'unknown']);
  });

  it('keeps the FULL package name as the chip title, so shortening loses nothing', () => {
    const facet = originFacets([run({ origin: CATALOG })]).find((f) => f.label !== 'all');
    expect(facet?.title).toBe(CATALOG);
  });

  it('omits the unknown chip when every run is attributed', () => {
    expect(originFacets([run({ origin: CATALOG })]).map((f) => f.filter.kind)).toEqual([
      'all',
      'origin',
    ]);
  });

  it('offers only "all" for an empty list (nothing to choose between)', () => {
    expect(originFacets([])).toHaveLength(1);
  });

  it('explains what unknown means instead of leaving it a bare word', () => {
    const unknown = originFacets(runs).find((f) => f.filter.kind === 'unknown');
    expect(unknown?.title).toMatch(/no recorded origin/i);
  });
});

describe('sameOriginFilter / originFilterKey', () => {
  it('compares by value, not identity', () => {
    expect(sameOriginFilter({ kind: 'all' }, ALL_ORIGINS)).toBe(true);
    expect(
      sameOriginFilter({ kind: 'origin', origin: CATALOG }, { kind: 'origin', origin: CATALOG }),
    ).toBe(true);
  });

  it('does not confuse two different packages, or a package with unknown', () => {
    expect(
      sameOriginFilter({ kind: 'origin', origin: CATALOG }, { kind: 'origin', origin: AGENT }),
    ).toBe(false);
    expect(sameOriginFilter({ kind: 'unknown' }, { kind: 'origin', origin: CATALOG })).toBe(false);
  });

  it('keys each facet distinctly', () => {
    expect(originFilterKey(ALL_ORIGINS)).toBe('all');
    expect(originFilterKey({ kind: 'unknown' })).toBe('unknown');
    expect(originFilterKey({ kind: 'origin', origin: CATALOG })).toBe(`origin:${CATALOG}`);
  });
});

describe('unknownOriginCount', () => {
  it('counts the unattributed bucket', () => {
    expect(unknownOriginCount([run({ origin: CATALOG }), run({}), run({ origin: '  ' })])).toBe(2);
  });
});

describe('emptyRunsNotice', () => {
  it('an unfiltered empty console just says there are no runs', () => {
    expect(emptyRunsNotice({ anyFilter: false, origin: ALL_ORIGINS, unknownCount: 3 })).toEqual({
      message: 'No runs yet.',
    });
  });

  it('a package filter that matched nothing NAMES the unattributed runs it cannot reach', () => {
    // The whole point: "none matched" and "these runs are unmatchable by any package filter" are
    // different facts, and an operator staring at an empty list must be able to tell them apart.
    const notice = emptyRunsNotice({
      anyFilter: true,
      origin: { kind: 'origin', origin: CATALOG },
      unknownCount: 12,
    });
    expect(notice.message).toContain('catalog-pipeline');
    expect(notice.unclassified).toBe(12);
  });

  it('does not offer the unclassified escape hatch when there is nothing in it', () => {
    const notice = emptyRunsNotice({
      anyFilter: true,
      origin: { kind: 'origin', origin: CATALOG },
      unknownCount: 0,
    });
    expect(notice.unclassified).toBeUndefined();
  });

  it('an empty unknown facet says everything is attributed, rather than looking swallowed', () => {
    const notice = emptyRunsNotice({
      anyFilter: true,
      origin: { kind: 'unknown' },
      unknownCount: 0,
    });
    expect(notice.message).toMatch(/none are unclassified/i);
    expect(notice.unclassified).toBeUndefined();
  });

  it('distinguishes "unclassified runs exist but other filters excluded them"', () => {
    const notice = emptyRunsNotice({
      anyFilter: true,
      origin: { kind: 'unknown' },
      unknownCount: 4,
    });
    expect(notice.message).toMatch(/No unclassified runs match the other filters/i);
  });

  it('falls back to a plain message when origin is not the narrowing axis', () => {
    expect(emptyRunsNotice({ anyFilter: true, origin: ALL_ORIGINS, unknownCount: 9 }).message).toBe(
      'No runs match these filters.',
    );
  });
});

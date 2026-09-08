import { describe, expect, it } from 'vitest';
import { runQueryString } from './run-query-string.js';

/** Decode what the builder emitted, the way a query parser would. */
function params(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe('runQueryString — the console filter as a filter envelope', () => {
  it('emits nothing for an empty filter, so the server keeps its defaults', () => {
    expect(runQueryString({})).toBe('');
    expect(runQueryString({ tag: [], namespace: [], attr: [] })).toBe('');
  });

  it('drops blank scalars rather than filtering on the empty string', () => {
    expect(runQueryString({ tag: '', namespace: '' })).toBe('');
  });

  it('emits scalars as equals and sets as in-lists', () => {
    const qs = params(runQueryString({ status: 'failed', tag: ['etl', 'nightly'] }));
    expect(qs.get('filter[status]')).toBe('failed');
    expect(qs.getAll('filter[tag][]')).toEqual(['etl', 'nightly']);
  });

  it('emits attribute predicates opaque, one string or a list', () => {
    const qs = params(
      runQueryString({ attr: ['amount:gte:200', 'tier:in:pro|enterprise', 'note:eq:with:colons'] }),
    );
    expect(qs.getAll('filter[attr][]')).toEqual([
      'amount:gte:200',
      'tier:in:pro|enterprise',
      'note:eq:with:colons',
    ]);
  });

  it('emits a lone attribute predicate as a scalar', () => {
    const qs = params(runQueryString({ attr: ['tier:eq:pro'] }));
    expect(qs.get('filter[attr]')).toBe('tier:eq:pro');
  });

  it('skips malformed attribute predicates instead of sending them', () => {
    const qs = params(runQueryString({ attr: ['tier', 'tier:bogus:pro'] }));
    expect(qs.toString()).not.toContain('filter%5Battr%5D');
    expect(qs.toString()).not.toContain('filter[attr]');
  });

  it('rides paging outside the filter envelope, as the ecosystem 1-based page/size', () => {
    const qs = params(runQueryString({ tag: 'etl' }, { page: 3, size: 100 }));
    expect(qs.get('filter[tag]')).toBe('etl');
    expect(qs.get('page')).toBe('3');
    expect(qs.get('size')).toBe('100');
    // The pre-0.39 spelling is gone — a server reading `limit`/`offset` would silently page wrong.
    expect(qs.get('limit')).toBeNull();
    expect(qs.get('offset')).toBeNull();
  });

  it('sends only the paging keys it was given, leaving the other to the server default', () => {
    expect(params(runQueryString({}, { size: 25 })).get('page')).toBeNull();
    expect(params(runQueryString({}, { size: 25 })).get('size')).toBe('25');
    expect(params(runQueryString({}, { page: 2 })).get('size')).toBeNull();
  });

  it('emits the values-picker envelope: scope plus axis, bound and search', () => {
    const qs = params(
      runQueryString({ namespace: ['acme'], attr: ['tier:eq:pro'] }, {}, { field: 'tag' }),
    );
    expect(qs.get('groupByCount[field]')).toBe('tag');
    // A one-element set collapses to a scalar equals — same request either way.
    expect(qs.get('filter[namespace]')).toBe('acme');
    expect(qs.get('filter[attr]')).toBe('tier:eq:pro');
  });

  it('bounds and searches the offered values server-side', () => {
    const qs = params(
      runQueryString({}, {}, { field: 'tag', limit: 50, offset: 50, search: 'et' }),
    );
    expect(qs.get('groupByCount[field]')).toBe('tag');
    expect(qs.get('groupByCount[limit]')).toBe('50');
    expect(qs.get('groupByCount[offset]')).toBe('50');
    expect(qs.get('groupByCount[search]')).toBe('et');
  });
});

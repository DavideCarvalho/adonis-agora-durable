import { applyCustomFilter, InvalidColumnFilterError } from '@adonis-agora/filter';
import { describe, expect, it } from 'vitest';
import { RunFilter } from '../../src/dashboard/run-filter.js';
import { RunQueryDraft } from '../../src/dashboard/run-query-draft.js';
import type { RunQuery } from '../../src/interfaces.js';

/** Run the console's filter class over a decoded query string, like the handlers do. */
async function filter(query: Record<string, unknown>): Promise<RunQuery> {
  const draft = new RunQueryDraft();
  await applyCustomFilter(draft, RunFilter, {
    request: { qs: () => ({ ...query }) },
  });
  return draft.query;
}

describe('RunFilter — the console run filter as a class', () => {
  it('reads the flat legacy spelling (scalars, repeats, attr strings)', async () => {
    expect(await filter({ status: 'failed' })).toEqual({ status: 'failed' });
    expect(await filter({ tag: ['etl', 'nightly'] })).toEqual({ tags: ['etl', 'nightly'] });
    expect(await filter({ namespace: 'acme' })).toEqual({ namespace: 'acme' });
    expect(await filter({ workflow: ['a', 'b'] })).toEqual({ workflows: ['a', 'b'] });
    expect(await filter({ attr: ['tier:eq:pro', 'amount:gte:200'] })).toEqual({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'gte', value: 200 },
      ],
    });
  });

  it('reads the structured filter envelope through the same methods', async () => {
    expect(
      await filter({
        filter: {
          status: 'failed',
          tag: ['etl', 'nightly'],
          namespace: 'acme',
          workflow: 'checkout',
          attr: ['tier:eq:pro'],
        },
      }),
    ).toEqual({
      status: 'failed',
      tags: ['etl', 'nightly'],
      namespace: 'acme',
      workflow: 'checkout',
      attributes: [{ key: 'tier', op: 'eq', value: 'pro' }],
    });
  });

  it('ignores unknown statuses and the origin in both spellings (no origin column)', async () => {
    expect(await filter({ status: 'from-the-future' })).toEqual({});
    expect(await filter({ origin: 'acme', status: 'failed' })).toEqual({ status: 'failed' });
    expect(await filter({ filter: { origin: 'acme', status: 'failed' } })).toEqual({
      status: 'failed',
    });
  });

  it('drops blank legacy params instead of matching a tenant named ""', async () => {
    expect(await filter({ namespace: '', tag: '' })).toEqual({});
  });

  it('reads structured attr.<key> predicates through the head-segment fallback', async () => {
    expect(
      await filter({
        filter: { where: [{ field: 'attr.tier', operator: 'equals', value: 'pro' }] },
      }),
    ).toEqual({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] });
    expect(
      await filter({
        filter: { where: [{ field: 'attr.amount', operator: 'in', value: [200, 300] }] },
      }),
    ).toEqual({ attributes: [{ key: 'amount', op: 'in', values: [200, 300] }] });
  });

  it('refuses unknown structured fields, bad operators and groups loudly', async () => {
    await expect(filter({ filter: { nope: 'x' } })).rejects.toThrow(InvalidColumnFilterError);
    await expect(
      filter({ filter: { where: [{ field: 'tag', operator: 'contains', value: 'x' }] } }),
    ).rejects.toThrow(InvalidColumnFilterError);
    await expect(
      filter({ filter: { where: [{ field: 'attr.tier', operator: 'contains', value: 'x' }] } }),
    ).rejects.toThrow(InvalidColumnFilterError);
    await expect(
      filter({
        where: [
          { field: '', operator: 'equals', OR: [{ field: 'tag', operator: 'equals', value: 'x' }] },
        ],
      }),
    ).rejects.toThrow(InvalidColumnFilterError);
  });

  it('facetQuery drops the status axes for the values scope', async () => {
    const draft = new RunQueryDraft();
    await applyCustomFilter(draft, RunFilter, {
      request: { qs: () => ({ status: 'failed', tag: 'etl' }) },
    });
    expect(draft.facetQuery()).toEqual({ tag: 'etl' });
  });

  it('reads numeric-keyed objects as lists (query-parser array overflow)', async () => {
    expect(await filter({ tag: { 0: 'etl', 1: 'nightly' } })).toEqual({
      tags: ['etl', 'nightly'],
    });
  });
});

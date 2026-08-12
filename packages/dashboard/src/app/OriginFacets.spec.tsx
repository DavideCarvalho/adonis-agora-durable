// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ALL_ORIGINS, type OriginFilter } from '../client/run-origin';
import { OriginFacets } from './OriginFacets';

// No jest-dom in this package (see `open-console.spec.tsx`): matchers like `toBeChecked` /
// `toBeDisabled` are not registered and would THROW rather than fail, so every assertion here reads
// a plain DOM property or attribute.

const CATALOG = '@adonis-agora/catalog-pipeline';
const AGENT = '@adonis-agora/agent';

const runs = [
  { origin: CATALOG },
  { origin: CATALOG },
  { origin: AGENT },
  { origin: undefined },
  { origin: undefined },
  { origin: undefined },
];

function chips(): HTMLButtonElement[] {
  return screen
    .getAllByRole('button')
    .filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement);
}

function chipByLabel(label: string): HTMLButtonElement {
  const found = chips().find((c) => c.textContent?.startsWith(label));
  if (!found)
    throw new Error(
      `no origin chip labelled ${label} (got ${chips()
        .map((c) => c.textContent)
        .join(' | ')})`,
    );
  return found;
}

describe('<OriginFacets>', () => {
  it('shows every origin with its count, and the unattributed bucket alongside them', () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chips().map((c) => c.textContent)).toEqual([
      'all6',
      'agent1',
      'catalog-pipeline2',
      'unknown3',
    ]);
  });

  it('keeps the unknown count on screen even while a package is selected', () => {
    // This is the reason the facet counts client-side instead of pushing `RunQuery.origin` down: a
    // store-filtered list would report zero unattributed runs, so they would look like they had
    // ceased to exist the moment an operator picked a library.
    render(
      <OriginFacets runs={runs} value={{ kind: 'origin', origin: CATALOG }} onChange={vi.fn()} />,
    );

    expect(chipByLabel('unknown').textContent).toBe('unknown3');
  });

  it('marks the selected facet as pressed, and only that one', () => {
    render(
      <OriginFacets runs={runs} value={{ kind: 'origin', origin: AGENT }} onChange={vi.fn()} />,
    );

    expect(chips().map((c) => c.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('defaults to "all" being the pressed chip', () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chipByLabel('all').getAttribute('aria-pressed')).toBe('true');
  });

  it('selects the unattributed bucket by value, so unclassified runs are reachable', () => {
    const onChange = vi.fn<(filter: OriginFilter) => void>();
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={onChange} />);

    chipByLabel('unknown').click();

    expect(onChange).toHaveBeenCalledWith({ kind: 'unknown' });
  });

  it('selects a package by its FULL name, not the shortened chip label', () => {
    const onChange = vi.fn<(filter: OriginFilter) => void>();
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={onChange} />);

    chipByLabel('catalog-pipeline').click();

    // Filtering on `catalog-pipeline` would match nothing — the stored origin is scoped.
    expect(onChange).toHaveBeenCalledWith({ kind: 'origin', origin: CATALOG });
  });

  it('spells out what unknown means rather than leaving a bare word', () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chipByLabel('unknown').getAttribute('title')).toMatch(/no recorded origin/i);
  });

  it('carries the full package name as a title, so shortening hides nothing', () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chipByLabel('catalog-pipeline').getAttribute('title')).toBe(CATALOG);
  });

  it('renders nothing when there is nothing to choose between', () => {
    const { container } = render(<OriginFacets runs={[]} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(container.innerHTML).toBe('');
  });
});

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
      'app3',
    ]);
  });

  it('keeps the app count on screen even while a package is selected', () => {
    // This is the reason the facet counts client-side instead of pushing `RunQuery.origin` down: a
    // store-filtered list would report zero unattributed runs, so they would look like they had
    // ceased to exist the moment an operator picked a library.
    render(
      <OriginFacets runs={runs} value={{ kind: 'origin', origin: CATALOG }} onChange={vi.fn()} />,
    );

    expect(chipByLabel('app').textContent).toBe('app3');
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

  it('selects the app bucket by value, so runs with no origin are reachable', () => {
    const onChange = vi.fn<(filter: OriginFilter) => void>();
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={onChange} />);

    chipByLabel('app').click();

    expect(onChange).toHaveBeenCalledWith({ kind: 'unknown' });
  });

  it('selects a package by its FULL name, not the shortened chip label', () => {
    const onChange = vi.fn<(filter: OriginFilter) => void>();
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={onChange} />);

    chipByLabel('catalog-pipeline').click();

    // Filtering on `catalog-pipeline` would match nothing — the stored origin is scoped.
    expect(onChange).toHaveBeenCalledWith({ kind: 'origin', origin: CATALOG });
  });

  it("spells out that the app chip is the app's own workflows (no package origin)", () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    const title = chipByLabel('app').getAttribute('title');
    expect(title).toMatch(/app's own workflows/i);
    expect(title).toMatch(/no package origin/i);
  });

  it('carries the full package name as a title, so shortening hides nothing', () => {
    render(<OriginFacets runs={runs} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chipByLabel('catalog-pipeline').getAttribute('title')).toBe(CATALOG);
  });

  it('renders nothing when there is nothing to choose between', () => {
    const { container } = render(<OriginFacets runs={[]} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(container.innerHTML).toBe('');
  });

  it("renders nothing when no run carries a named origin (only the app's own runs)", () => {
    // The plain-app case: no workflow declares an origin, so `all 3 | app 3` would be pure noise.
    const appOnly = [{ origin: undefined }, { origin: '' }, { origin: undefined }];
    const { container } = render(
      <OriginFacets runs={appOnly} value={ALL_ORIGINS} onChange={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows the row once a single run has a named origin, with app carrying the rest', () => {
    const mixed = [{ origin: CATALOG }, { origin: undefined }, { origin: undefined }];
    render(<OriginFacets runs={mixed} value={ALL_ORIGINS} onChange={vi.fn()} />);

    expect(chips().map((c) => c.textContent)).toEqual(['all3', 'catalog-pipeline1', 'app2']);
  });

  it('keeps the row while a non-default facet is selected, so the operator can get back to all', () => {
    const onChange = vi.fn<(filter: OriginFilter) => void>();
    render(
      <OriginFacets
        runs={[{ origin: undefined }]}
        value={{ kind: 'unknown' }}
        onChange={onChange}
      />,
    );

    chipByLabel('all').click();
    expect(onChange).toHaveBeenCalledWith(ALL_ORIGINS);
  });
});

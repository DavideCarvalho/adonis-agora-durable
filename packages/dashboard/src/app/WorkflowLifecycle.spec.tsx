// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleSubscriptionLink, WorkflowLifecyclePage } from '../client/durable-client';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

const workflowLifecycle = vi.fn<(workflow: string) => Promise<WorkflowLifecyclePage>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      workflowLifecycle: (workflow: string) => workflowLifecycle(workflow),
    },
  };
});

// Imported AFTER the mock so the page picks up the mocked `durableClient`.
const {
  subscriptionTraits,
  triggerCountLabel,
  workflowFromHash,
  workflowHash,
  WorkflowLifecycleLists,
  WorkflowPage,
} = await import('./WorkflowLifecycle');

function link(overrides: Partial<LifecycleSubscriptionLink> = {}): LifecycleSubscriptionLink {
  return {
    workflow: 'refresh',
    kind: 'completed',
    local: true,
    announced: false,
    where: false,
    input: false,
    ...overrides,
  };
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('workflow hashes', () => {
  it('round-trips a workflow name through the URL hash', () => {
    expect(workflowHash('billing/charge card')).toBe('#/workflow/billing%2Fcharge%20card');
    expect(workflowFromHash(workflowHash('billing/charge card'))).toBe('billing/charge card');
    expect(workflowFromHash('#/run/r1')).toBeUndefined();
    expect(workflowFromHash('')).toBeUndefined();
  });
});

describe('subscriptionTraits', () => {
  it('names what a subscription does beyond starting the run', () => {
    expect(subscriptionTraits(link())).toEqual([]);
    expect(
      subscriptionTraits(
        link({ where: true, input: true, coalesce: { mode: 'debounce', keyed: true } }),
      ),
    ).toEqual(['where', 'input', 'debounce by key']);
    expect(subscriptionTraits(link({ coalesce: { mode: 'batch', keyed: false } }))).toEqual([
      'batch',
    ]);
    expect(subscriptionTraits(link({ local: false, announced: true }))).toEqual(['announced']);
  });
});

describe('triggerCountLabel', () => {
  it('prints a subscriber’s counts, or nothing without them', () => {
    expect(triggerCountLabel({ a: { triggered: 4, failed: 0 } }, 'a')).toBe('4 started');
    expect(triggerCountLabel({ a: { triggered: 4, failed: 1 } }, 'a')).toBe('4 started · 1 failed');
    expect(triggerCountLabel({ a: { triggered: 4, failed: 1 } }, 'b')).toBeUndefined();
    expect(triggerCountLabel(undefined, 'a')).toBeUndefined();
  });
});

describe('WorkflowLifecycleLists', () => {
  it('lists both directions, each entry linking to its workflow page', () => {
    render(
      <WorkflowLifecycleLists
        links={{
          workflow: 'ingest',
          startsOnSettle: [
            link({ workflow: 'refresh', where: true }),
            link({ workflow: 'notify', kind: 'failed', local: false, announced: true }),
          ],
          startedBy: [link({ workflow: 'upload' })],
        }}
      />,
    );
    const starts = screen.getByRole('region', { name: 'Starts when it settles' });
    expect([...starts.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '#/workflow/refresh',
      '#/workflow/notify',
    ]);
    expect(starts.textContent).toContain('on completed');
    expect(starts.textContent).toContain('where');
    expect(starts.textContent).toContain('on failed');
    expect(starts.textContent).toContain('announced');
    const startedBy = screen.getByRole('region', { name: 'Started by' });
    expect(startedBy.querySelector('a')?.getAttribute('href')).toBe('#/workflow/upload');
  });

  it('says so when a direction is empty', () => {
    render(<WorkflowLifecycleLists links={{ workflow: 'x', startsOnSettle: [], startedBy: [] }} />);
    expect(screen.getByText('No workflow starts when it settles.')).toBeTruthy();
    expect(screen.getByText("No workflow's settling starts it.")).toBeTruthy();
  });
});

describe('WorkflowPage', () => {
  it("loads the workflow's links from the gateway", async () => {
    workflowLifecycle.mockResolvedValue({
      workflow: 'ingest',
      startsOnSettle: [link({ workflow: 'refresh' })],
      startedBy: [],
    });
    render(wrap(<WorkflowPage workflow="ingest" />));
    await waitFor(() => expect(screen.getByText('refresh')).toBeTruthy());
    expect(workflowLifecycle).toHaveBeenCalledWith('ingest');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ingest');
  });

  it('shows how many runs each subscriber was started for, and how many starts failed', async () => {
    workflowLifecycle.mockResolvedValue({
      workflow: 'ingest',
      startsOnSettle: [link({ workflow: 'refresh' }), link({ workflow: 'notify' })],
      startedBy: [],
      triggerCounts: {
        refresh: { triggered: 12, failed: 0 },
        notify: { triggered: 3, failed: 2 },
      },
    });
    render(wrap(<WorkflowPage workflow="ingest" />));
    await waitFor(() => expect(screen.getByText('12 started')).toBeTruthy());
    expect(screen.getByText('3 started · 2 failed')).toBeTruthy();
  });

  it('shows the error when the gateway cannot answer', async () => {
    workflowLifecycle.mockRejectedValue(new Error('workflow lifecycle links are unavailable'));
    render(wrap(<WorkflowPage workflow="ingest" />));
    await waitFor(() =>
      expect(screen.getByText('workflow lifecycle links are unavailable')).toBeTruthy(),
    );
  });
});

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult, WaitTarget } from '../client/durable-client';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

const signal = vi.fn<(id: string, token: string, payload?: unknown) => Promise<RunResult>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      signal: (id: string, token: string, payload?: unknown) => signal(id, token, payload),
    },
  };
});

// Imported AFTER the mock so the panel picks up the mocked `durableClient`; the error class comes
// from the SAME (mocked) module graph so `instanceof` in the component matches.
const { DurableActionError } = await import('../client/durable-client');
const { WaitingActions } = await import('./WaitingActions');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const signalTarget: WaitTarget = { kind: 'signal', token: 'approve' };

async function openSignalDialog(targets: WaitTarget[] = [signalTarget], onDelivered = vi.fn()) {
  render(
    <WaitingActions runId="run-1" targets={targets} tenantPod={false} onDelivered={onDelivered} />,
    { wrapper },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Deliver signal' }));
  const dialog = await screen.findByRole('dialog');
  return { dialog, onDelivered };
}

describe('WaitingActions: the deliver-signal dialog', () => {
  beforeEach(() => signal.mockReset());

  it('pre-fills the waited token, parses the payload, posts it and refreshes on success', async () => {
    signal.mockResolvedValue({ runId: 'run-1', status: 'running' });
    const { dialog, onDelivered } = await openSignalDialog();

    const token = within(dialog).getByLabelText('signal token') as HTMLInputElement;
    expect(token.value).toBe('approve');
    fireEvent.change(within(dialog).getByLabelText(/payload/), {
      target: { value: '{ "approved": true }' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deliver signal' }));

    await waitFor(() =>
      expect(signal).toHaveBeenCalledWith('run-1', 'approve', { approved: true }),
    );
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an EMPTY payload delivers undefined — not "" and not null', async () => {
    signal.mockResolvedValue({ runId: 'run-1', status: 'running' });
    const { dialog } = await openSignalDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deliver signal' }));
    await waitFor(() => expect(signal).toHaveBeenCalledWith('run-1', 'approve', undefined));
  });

  it('refuses to send malformed JSON — the parse error renders inline and the draft survives', async () => {
    const { dialog } = await openSignalDialog();
    fireEvent.change(within(dialog).getByLabelText(/payload/), {
      target: { value: '{ nope' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deliver signal' }));

    expect(signal).not.toHaveBeenCalled();
    expect((within(dialog).getByLabelText(/payload/) as HTMLTextAreaElement).value).toBe('{ nope');
  });

  it("surfaces a 409's waitingOn list as selectable tokens, and the pick retargets the field", async () => {
    signal.mockRejectedValueOnce(
      new DurableActionError(409, 'run run-1 is not waiting on "approve"', {
        error: 'run run-1 is not waiting on "approve"',
        waitingOn: ['wh:run-1:3', 'confirm-refund'],
      }),
    );
    signal.mockResolvedValueOnce({ runId: 'run-1', status: 'running' });
    const { dialog, onDelivered } = await openSignalDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deliver signal' }));

    // The refusal names itself AND offers what the run IS waiting on.
    await within(dialog).findByText('run run-1 is not waiting on "approve"');
    await within(dialog).findByText('waiting on — pick one');
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm-refund' }));
    expect((within(dialog).getByLabelText('signal token') as HTMLInputElement).value).toBe(
      'confirm-refund',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deliver signal' }));
    await waitFor(() =>
      expect(signal).toHaveBeenLastCalledWith('run-1', 'confirm-refund', undefined),
    );
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
  });

  it('disables every verb on a tenant deployment, with the reason — same gating as fix-and-replay', () => {
    render(
      <WaitingActions
        runId="run-1"
        targets={[signalTarget, { kind: 'task', token: 'task:run-1:qa', name: 'qa' }]}
        tenantPod={true}
        onDelivered={vi.fn()}
      />,
      { wrapper },
    );
    for (const name of ['Deliver signal', 'Complete task', 'Fail task']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain('Not available on a tenant deployment');
    }
  });

  it('renders nothing at all when the run waits on nothing actionable', () => {
    const { container } = render(
      <WaitingActions runId="run-1" targets={[]} tenantPod={false} onDelivered={vi.fn()} />,
      { wrapper },
    );
    expect(container.innerHTML).toBe('');
  });
});

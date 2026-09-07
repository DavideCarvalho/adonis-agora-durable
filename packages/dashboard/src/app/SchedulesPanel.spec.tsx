// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult, ScheduleInfo } from '../client/durable-client';
import { TooltipProvider } from './ui/tooltip';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

const schedules = vi.fn<() => Promise<ScheduleInfo[]>>();
const setSchedulePaused =
  vi.fn<(key: string, paused: boolean) => Promise<{ key: string; paused: boolean }>>();
const triggerSchedule = vi.fn<(key: string) => Promise<RunResult>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      schedules: () => schedules(),
      setSchedulePaused: (key: string, paused: boolean) => setSchedulePaused(key, paused),
      triggerSchedule: (key: string) => triggerSchedule(key),
    },
  };
});

// Imported AFTER the mock so the panel picks up the mocked `durableClient`.
const { cadenceOf, humanizeEveryMs, relUntilMs, SchedulesPanel } = await import('./SchedulesPanel');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function schedule(overrides: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    key: 'nightly-report',
    workflow: 'nightlyReport',
    cron: '0 3 * * *',
    timezone: 'America/Sao_Paulo',
    paused: false,
    pausedAtRuntime: false,
    lastFireAt: Date.now() - 3_600_000,
    nextFireAt: Date.now() + 3_600_000,
    currentWindowRunId: 'rep-window-1',
    lastRunStatus: 'suspended',
    ...overrides,
  };
}

async function renderPanel(rows: ScheduleInfo[], onOpenRun = vi.fn()) {
  schedules.mockResolvedValue(rows);
  render(<SchedulesPanel onOpenRun={onOpenRun} />, { wrapper });
  await waitFor(() => expect(schedules).toHaveBeenCalled());
  return onOpenRun;
}

describe('cadenceOf / humanizeEveryMs: the cadence column speaks the operator dialect', () => {
  it('shows a cron expression VERBATIM — the operator wrote it, prose would obscure it', () => {
    expect(cadenceOf({ cron: '0 3 * * *' })).toBe('0 3 * * *');
  });

  it('humanizes an everyMs interval to one unit', () => {
    expect(humanizeEveryMs(500)).toBe('500ms');
    expect(humanizeEveryMs(30_000)).toBe('30s');
    expect(humanizeEveryMs(300_000)).toBe('5m');
    expect(humanizeEveryMs(5_400_000)).toBe('1.5h');
    expect(humanizeEveryMs(172_800_000)).toBe('2d');
    expect(cadenceOf({ everyMs: 300_000 })).toBe('every 5m');
  });

  it('relUntilMs renders a future instant relatively and a past one as due now, never negative', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(relUntilMs(now + 240_000, now)).toBe('in 4m');
    expect(relUntilMs(now - 5_000, now)).toBe('due now');
  });
});

describe('SchedulesPanel: the schedules table', () => {
  beforeEach(() => {
    schedules.mockReset();
    setSchedulePaused.mockReset();
    triggerSchedule.mockReset();
  });

  it('renders key, workflow, cadence, timezone and the paused badge with the runtime-override hint', async () => {
    await renderPanel([
      schedule(),
      schedule({
        key: 'carrier-poll',
        workflow: 'shipmentSync',
        cron: undefined,
        everyMs: 30_000,
        timezone: undefined,
        paused: true,
        pausedAtRuntime: true,
        lastRunStatus: undefined,
      }),
    ]);
    await screen.findByText('nightly-report');
    expect(screen.getByText('nightlyReport')).toBeTruthy();
    expect(screen.getByText('0 3 * * *')).toBeTruthy();
    expect(screen.getByText('America/Sao_Paulo')).toBeTruthy();
    // The interval schedule humanizes; the missing timezone reads as the engine's UTC default.
    expect(screen.getByText('every 30s')).toBeTruthy();
    expect(screen.getByText('UTC')).toBeTruthy();
    // The runtime pause is NAMED as an override, not just "paused" — config did not do this.
    expect(screen.getByText('paused · runtime override')).toBeTruthy();
  });

  it("links the last window's run status to the run itself", async () => {
    const onOpenRun = await renderPanel([schedule()]);
    fireEvent.click(await screen.findByText('suspended'));
    expect(onOpenRun).toHaveBeenCalledWith('rep-window-1');
  });

  it('Pause posts the runtime pause for the row and Resume clears it', async () => {
    setSchedulePaused.mockResolvedValue({ key: 'nightly-report', paused: true });
    await renderPanel([
      schedule(),
      schedule({ key: 'carrier-poll', paused: true, pausedAtRuntime: true }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(setSchedulePaused).toHaveBeenCalledWith('nightly-report', true));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(setSchedulePaused).toHaveBeenCalledWith('carrier-poll', false));
  });

  it('Run now triggers the schedule and navigates to the run the server answered with', async () => {
    triggerSchedule.mockResolvedValue({ runId: 'rep-window-1', status: 'running' });
    const onOpenRun = await renderPanel([schedule()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(triggerSchedule).toHaveBeenCalledWith('nightly-report'));
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('rep-window-1'));
  });

  it('degrades to an unavailable note when the endpoint 404s (tenant topology / older server)', async () => {
    schedules.mockRejectedValue(new Error('404 Not Found'));
    render(<SchedulesPanel onOpenRun={vi.fn()} />, { wrapper });
    await screen.findByText('Schedules are not available here.');
    expect(screen.getByText(/404 Not Found/).textContent).toContain('404 Not Found');
  });
});

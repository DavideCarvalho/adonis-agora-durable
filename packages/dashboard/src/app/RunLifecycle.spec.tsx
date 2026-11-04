// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleDelivery } from '../client/durable-client';
import {
  deliveryNote,
  formatSpan,
  LIFECYCLE_PENDING_TAG,
  LifecycleDeliveries,
  LifecyclePendingFilter,
  LifecycleSourceLine,
  RunWaits,
} from './RunLifecycle';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

const HOUR = 60 * 60 * 1000;

describe('formatSpan', () => {
  it('prints the largest unit that keeps the number small', () => {
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(12 * 60_000)).toBe('12m');
    expect(formatSpan(3 * HOUR)).toBe('3h');
    expect(formatSpan(72 * HOUR)).toBe('3d');
    expect(formatSpan(-5)).toBe('0s');
  });
});

describe('deliveryNote', () => {
  const now = 100 * HOUR;
  it('says how long an owed subscriber has been owed, and when it becomes an orphan', () => {
    expect(deliveryNote({ subscriber: 'a', state: 'owed', owedSince: now - 2 * HOUR }, now)).toBe(
      'owed for 2h',
    );
    expect(
      deliveryNote(
        { subscriber: 'a', state: 'owed', owedSince: now - 2 * HOUR, orphanAt: now + 22 * HOUR },
        now,
      ),
    ).toBe('owed for 2h · orphan in 22h');
  });

  it('names the other states', () => {
    expect(deliveryNote({ subscriber: 'a', state: 'started' }, now)).toBe('started');
    expect(deliveryNote({ subscriber: 'a', state: 'coalesced' }, now)).toBe('coalesced');
    expect(deliveryNote({ subscriber: 'a', state: 'not-started' }, now)).toBe('not started');
  });

  it('says a failed subscriber failed, with the reason when it is known', () => {
    expect(deliveryNote({ subscriber: 'a', state: 'failed' }, now)).toBe('failed');
    expect(deliveryNote({ subscriber: 'a', state: 'failed', error: 'bad input' }, now)).toBe(
      'failed: bad input',
    );
  });
});

describe('LifecycleDeliveries', () => {
  const now = 100 * HOUR;
  const deliveries: LifecycleDelivery[] = [
    { subscriber: 'audit', state: 'started', runId: 'evt:i1:completed:audit', status: 'completed' },
    { subscriber: 'notify', state: 'owed', owedSince: now - HOUR, orphanAt: now + 23 * HOUR },
    { subscriber: 'refresh', state: 'coalesced', runId: '__evtacc__:refresh' },
    { subscriber: 'picky', state: 'not-started' },
  ];

  it('draws one row per subscriber with its state, linking the started and accumulator runs', () => {
    const onOpenRun = vi.fn();
    const { container } = render(
      <LifecycleDeliveries deliveries={deliveries} now={now} onOpenRun={onOpenRun} />,
    );
    const rows = [...container.querySelectorAll('li')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'started',
      'owed',
      'coalesced',
      'not-started',
    ]);
    expect(rows[0]?.textContent).toContain('completed');
    expect(rows[1]?.textContent).toContain('owed for 1h · orphan in 23h');

    fireEvent.click(screen.getByText('evt:i1:completed:audit'));
    fireEvent.click(screen.getByText('__evtacc__:refresh'));
    expect(onOpenRun.mock.calls).toEqual([['evt:i1:completed:audit'], ['__evtacc__:refresh']]);
  });

  it('draws nothing without deliveries', () => {
    const { container } = render(<LifecycleDeliveries deliveries={[]} onOpenRun={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('RunWaits', () => {
  it('says which run a run waits for and which runs await it, linked with their status', () => {
    const onOpenRun = vi.fn();
    render(
      <RunWaits
        waitsFor={[{ runId: 'i1', seq: 2, status: 'running' }]}
        awaitedBy={[
          { runId: 'w1', seq: 0, status: 'suspended' },
          { runId: 'w2', seq: 4 },
        ]}
        onOpenRun={onOpenRun}
      />,
    );
    expect(screen.getByTestId('waits-for').textContent).toContain('Waiting for run');
    expect(screen.getByTestId('waits-for').textContent).toContain('running');
    expect(screen.getByTestId('awaited-by').textContent).toContain('Awaited by');
    fireEvent.click(screen.getByText('i1'));
    fireEvent.click(screen.getByText('w2'));
    expect(onOpenRun.mock.calls).toEqual([['i1'], ['w2']]);
  });

  it('draws nothing when the run neither waits nor is awaited', () => {
    const { container } = render(<RunWaits onOpenRun={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('LifecycleSourceLine', () => {
  it('names the source run, how it ended, its status and its trace id', () => {
    const onOpenRun = vi.fn();
    render(
      <LifecycleSourceLine
        source={{
          runId: 'i1',
          kind: 'failed',
          status: 'failed',
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        }}
        onOpenRun={onOpenRun}
      />,
    );
    const line = screen.getByTestId('lifecycle-source').textContent ?? '';
    expect(line).toContain('started by');
    expect(line).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(screen.getByText('copy')).toBeTruthy();
    fireEvent.click(screen.getByText('i1'));
    expect(onOpenRun).toHaveBeenCalledWith('i1');
  });

  it('leaves the trace out when the source recorded none', () => {
    render(
      <LifecycleSourceLine source={{ runId: 'i1', kind: 'completed' }} onOpenRun={() => {}} />,
    );
    expect(screen.queryByText('copy')).toBeNull();
  });
});

describe('LifecyclePendingFilter', () => {
  it('adds and removes the pending tag, keeping the other tags', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LifecyclePendingFilter tags={['etl']} onChange={onChange} />);
    const chip = screen.getByText('lifecycle pending');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith(['etl', LIFECYCLE_PENDING_TAG]);

    rerender(<LifecyclePendingFilter tags={['etl', LIFECYCLE_PENDING_TAG]} onChange={onChange} />);
    expect(screen.getByText('lifecycle pending').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('lifecycle pending'));
    expect(onChange).toHaveBeenLastCalledWith(['etl']);
  });
});

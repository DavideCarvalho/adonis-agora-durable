// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent, LifecycleDelivery } from '../client/durable-client';
import { EVENT_TAIL_LIMIT, EventTail } from '../client/event-tail';
import {
  eventLinks,
  eventSummary,
  LiveLifecycleDeliveries,
  lifecycleSourceRunId,
  RunEvents,
  triggerFailures,
} from './RunEvents';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

const at = '2026-01-01T10:00:00.000Z';
const ev = (e: Partial<EngineEvent> & Pick<EngineEvent, 'type' | 'runId'>): EngineEvent => ({
  at,
  ...e,
});

/** A fake run stream: what `durableClient.streamRun` hands its `onEvent`, driven by the test. */
function fakeStream() {
  const tail = new EventTail();
  return { tail, emit: (e: EngineEvent) => act(() => tail.push(e)) };
}

describe('EventTail', () => {
  it(`keeps the last ${EVENT_TAIL_LIMIT} events, oldest first, and tells subscribers`, () => {
    const tail = new EventTail();
    const told = vi.fn();
    tail.subscribe(told);
    for (let i = 0; i < EVENT_TAIL_LIMIT + 5; i += 1) {
      tail.push(ev({ type: 'step.started', runId: 'r1', seq: i }));
    }
    const kept = tail.snapshot();
    expect(kept).toHaveLength(EVENT_TAIL_LIMIT);
    expect(kept[0]?.event.seq).toBe(5);
    expect(kept[0]?.id).toBe(6);
    expect(kept.at(-1)?.event.seq).toBe(EVENT_TAIL_LIMIT + 4);
    expect(told).toHaveBeenCalledTimes(EVENT_TAIL_LIMIT + 5);
  });
});

describe('eventLinks', () => {
  it('links a settled run to the run its lifecycle event started, and that run back to it', () => {
    expect(
      eventLinks(
        ev({
          type: 'run.triggered',
          runId: 'i1',
          name: 'refresh',
          triggeredRunId: 'evt:i1:completed:refresh',
        }),
      ),
    ).toEqual([{ rel: 'triggered', runId: 'evt:i1:completed:refresh' }]);
    expect(
      eventLinks(
        ev({ type: 'run.started', runId: 'evt:i1:completed:refresh', workflow: 'refresh' }),
      ),
    ).toEqual([{ rel: 'source', runId: 'i1' }]);
  });

  it('links a parent to its child step, and a child run back to its parent', () => {
    expect(eventLinks(ev({ type: 'step.started', runId: 'p', name: 'spawn:p.child.0' }))).toEqual([
      { rel: 'child', runId: 'p.child.0' },
    ]);
    expect(
      eventLinks(ev({ type: 'step.completed', runId: 'p', name: 'signal:child:p.child.1' })),
    ).toEqual([{ rel: 'child', runId: 'p.child.1' }]);
    expect(eventLinks(ev({ type: 'run.started', runId: 'p.child.0', workflow: 'w' }))).toEqual([
      { rel: 'parent', runId: 'p' },
    ]);
  });

  it('links nothing for other events', () => {
    expect(eventLinks(ev({ type: 'run.completed', runId: 'r1' }))).toEqual([]);
    expect(eventLinks(ev({ type: 'step.started', runId: 'r1', name: 'charge' }))).toEqual([]);
  });

  it('reads a lifecycle source only from a matching evt: id', () => {
    expect(lifecycleSourceRunId('evt:a:b:failed:alert', 'alert')).toBe('a:b');
    expect(lifecycleSourceRunId('evt:a:completed:other', 'alert')).toBeUndefined();
    expect(lifecycleSourceRunId('r1', 'alert')).toBeUndefined();
  });
});

describe('eventSummary', () => {
  it('names the subscriber and the error of a failed trigger', () => {
    expect(
      eventSummary(
        ev({ type: 'run.trigger_failed', runId: 'i1', name: 'strict', error: { message: 'bad' } }),
      ),
    ).toBe('subscriber strict · bad');
    expect(eventSummary(ev({ type: 'step.completed', runId: 'r', name: 'x', durationMs: 4 }))).toBe(
      'x · 4ms',
    );
  });
});

describe('triggerFailures', () => {
  it('keeps the last error per subscriber, until a later trigger starts it', () => {
    const errors = triggerFailures(
      [
        ev({ type: 'run.trigger_failed', runId: 'i1', name: 'a', error: { message: 'one' } }),
        ev({ type: 'run.trigger_failed', runId: 'i1', name: 'a', error: { message: 'two' } }),
        ev({ type: 'run.trigger_failed', runId: 'i1', name: 'b', error: { message: 'b failed' } }),
        ev({ type: 'run.triggered', runId: 'i1', name: 'b', triggeredRunId: 'evt:i1:completed:b' }),
      ].map((event, i) => ({ id: i + 1, event })),
    );
    expect([...errors]).toEqual([['a', 'two']]);
  });
});

describe('RunEvents', () => {
  it('says the panel is live only while nothing arrived', () => {
    const { tail } = fakeStream();
    render(<RunEvents tail={tail} onOpenRun={() => {}} />);
    expect(screen.getByTestId('run-events').textContent).toContain(
      'Nothing is stored, so earlier events are not shown',
    );
  });

  it('draws events as the stream delivers them, newest first, with their links', () => {
    const { tail, emit } = fakeStream();
    const onOpenRun = vi.fn();
    const { container } = render(<RunEvents tail={tail} onOpenRun={onOpenRun} />);

    emit(ev({ type: 'run.completed', runId: 'i1', workflow: 'ingest' }));
    emit(
      ev({
        type: 'run.triggered',
        runId: 'i1',
        name: 'refresh',
        triggeredRunId: 'evt:i1:completed:refresh',
      }),
    );
    emit(
      ev({
        type: 'run.trigger_failed',
        runId: 'i1',
        name: 'strict',
        error: { message: 'bad input' },
      }),
    );

    const rows = [...container.querySelectorAll('li')];
    expect(rows.map((r) => r.getAttribute('data-type'))).toEqual([
      'run.trigger_failed',
      'run.triggered',
      'run.completed',
    ]);
    expect(rows[0]?.textContent).toContain('subscriber strict · bad input');
    expect(rows[0]?.textContent).toContain('10:00:00.000');
    expect(screen.getByRole('heading', { name: 'Events · 3' })).toBeTruthy();

    fireEvent.click(screen.getByText('evt:i1:completed:refresh'));
    expect(onOpenRun).toHaveBeenCalledWith('evt:i1:completed:refresh');
  });
});

describe('LiveLifecycleDeliveries', () => {
  it('fills a failed subscriber’s reason from the run.trigger_failed the stream delivered', () => {
    const { tail, emit } = fakeStream();
    const deliveries: LifecycleDelivery[] = [{ subscriber: 'strict', state: 'failed' }];
    const { container } = render(
      <LiveLifecycleDeliveries deliveries={deliveries} tail={tail} onOpenRun={() => {}} />,
    );
    const row = () => container.querySelector('li[data-state="failed"]');
    expect(row()?.textContent).toContain('failed');
    expect(row()?.textContent).toContain('see the run.trigger_failed event for the reason');

    emit(
      ev({
        type: 'run.trigger_failed',
        runId: 'i1',
        name: 'strict',
        error: { message: 'bad input' },
      }),
    );
    expect(row()?.textContent).toContain('failed: bad input');
    expect(row()?.textContent).not.toContain('see the run.trigger_failed event');
  });
});

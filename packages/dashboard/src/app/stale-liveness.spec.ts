import { describe, expect, it } from 'vitest';
import type { GroupHealth, StepCheckpoint } from '../client/durable-client';
import { LIVE_BEAT_WINDOW_MS, stalePendingView } from './stale-liveness';

const NOW = 1_700_000_000_000;

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'IngestionReadService.runIngestionRead',
    kind: 'remote',
    status: 'pending',
    startedAt: new Date(NOW - 33 * 60_000).toISOString(),
    finishedAt: new Date(NOW - 33 * 60_000).toISOString(),
    workerGroup: 'IngestionReadService.runIngestionRead',
    ...over,
  } as StepCheckpoint;
}

function health(liveWorkers: GroupHealth['liveWorkers']): GroupHealth {
  return { group: 'IngestionReadService.runIngestionRead', depth: 1, liveWorkers };
}

describe('stalePendingView', () => {
  it('a fresh worker heartbeat on the group ⇒ working (delivered + held), not "possibly lost"', () => {
    const view = stalePendingView(
      step(),
      health([
        {
          group: 'IngestionReadService.runIngestionRead',
          instanceId: 'ts-desktop-1',
          lastBeatAt: NOW - 4_000,
          status: { inFlight: 1 } as never,
        },
      ]),
      NOW,
    );
    expect(view).toEqual({ kind: 'working', instanceId: 'ts-desktop-1', beatAgoS: 4, inFlight: 1 });
  });

  it('picks the FRESHEST live worker when several serve the group', () => {
    const view = stalePendingView(
      step(),
      health([
        { group: 'g', instanceId: 'old', lastBeatAt: NOW - 60_000 },
        { group: 'g', instanceId: 'fresh', lastBeatAt: NOW - 2_000 },
      ]),
      NOW,
    );
    expect(view.kind).toBe('working');
    expect((view as { instanceId: string }).instanceId).toBe('fresh');
  });

  it('an EXPIRED heartbeat does not count — lost, with minutes since dispatch', () => {
    const view = stalePendingView(
      step(),
      health([{ group: 'g', instanceId: 'dead', lastBeatAt: NOW - LIVE_BEAT_WINDOW_MS - 1_000 }]),
      NOW,
    );
    expect(view).toEqual({ kind: 'lost', minutes: 33 });
  });

  it('no health for the group at all ⇒ lost', () => {
    expect(stalePendingView(step(), undefined, NOW)).toEqual({ kind: 'lost', minutes: 33 });
  });

  it('an older SDK heartbeat without a status still reads as working (inFlight undefined)', () => {
    const view = stalePendingView(
      step(),
      health([{ group: 'g', instanceId: 'py-desktop-9', lastBeatAt: NOW - 10_000 }]),
      NOW,
    );
    expect(view).toEqual({
      kind: 'working',
      instanceId: 'py-desktop-9',
      beatAgoS: 10,
      inFlight: undefined,
    });
  });

  it('minutes fall back to startedAt when enqueuedAt is absent, and use enqueuedAt when present', () => {
    const withEnqueued = step({ enqueuedAt: new Date(NOW - 12 * 60_000).toISOString() } as never);
    expect(stalePendingView(withEnqueued, undefined, NOW)).toEqual({ kind: 'lost', minutes: 12 });
  });
});

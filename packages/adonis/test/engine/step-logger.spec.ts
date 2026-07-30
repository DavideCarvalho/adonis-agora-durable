import { describe, expect, it } from 'vitest';
import type { StepEvent } from '../../src/interfaces.js';
import { createStepLogger } from '../../src/step-logger.js';

const at = () => 1000;

describe('createStepLogger', () => {
  it('sub() keeps its existing shape (no subId — back-compat)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).sub('ProcessKpi', 'ok');
    expect(events).toEqual([
      { at: 1000, level: 'info', message: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' },
    ]);
  });

  it('subEvent() records an intermediate phase (no status)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      group: 'af_fleet',
      phase: 'processing',
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'info',
        message: 'processing',
        subId: 'r1',
        name: 'ProcessKpi',
        group: 'af_fleet',
        phase: 'processing',
      },
    ]);
  });

  it('subEvent() records a terminal outcome, mapping failed → error level and keeping data', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      status: 'failed',
      data: { durationMs: 42 },
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'error',
        message: 'ProcessKpi',
        subId: 'r1',
        name: 'ProcessKpi',
        status: 'failed',
        data: { durationMs: 42 },
      },
    ]);
  });

  it('subEvent() maps skipped → warn level', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({ id: 'r1', name: 'ProcessKpi', status: 'skipped' });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'warn',
        message: 'ProcessKpi',
        subId: 'r1',
        name: 'ProcessKpi',
        status: 'skipped',
      },
    ]);
  });

  describe('subProcess()', () => {
    // A clock that advances 250ms per read, so durationMs is deterministic (start → terminal).
    const tickingClock = () => {
      let t = 1000;
      return () => {
        t += 250;
        return t;
      };
    };

    it('records a terminal ok with the measured durationMs and returns the body value', async () => {
      const events: StepEvent[] = [];
      const out = await createStepLogger(events, tickingClock()).subProcess(
        'export-file',
        async () => 'done',
        { id: 's1', group: 'exports' },
      );
      expect(out).toBe('done');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: 'info',
        subId: 's1',
        name: 'export-file',
        group: 'exports',
        status: 'ok',
      });
      expect((events[0]!.data as { durationMs: number }).durationMs).toBeGreaterThan(0);
    });

    it('records failed with the error message and re-throws', async () => {
      const events: StepEvent[] = [];
      const logger = createStepLogger(events, at);
      await expect(
        logger.subProcess(
          'export-file',
          async () => {
            throw new Error('s3 down');
          },
          { id: 's1' },
        ),
      ).rejects.toThrow('s3 down');
      expect(events).toEqual([
        {
          at: 1000,
          level: 'error',
          message: 's3 down',
          subId: 's1',
          name: 'export-file',
          status: 'failed',
          data: { durationMs: 0 },
        },
      ]);
    });

    it('skip() records a terminal skipped and suppresses the ok', async () => {
      const events: StepEvent[] = [];
      await createStepLogger(events, at).subProcess(
        'fetch-data',
        async (sp) => sp.skip('nothing to export'),
        { id: 's1' },
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 'skipped',
        message: 'nothing to export',
        subId: 's1',
      });
    });

    it('tags logs emitted inside the body with the sub-process id', async () => {
      const events: StepEvent[] = [];
      const logger = createStepLogger(events, at);
      await logger.subProcess(
        'fetch-data',
        async (sp) => {
          sp.phase('querying');
          logger.info('page 1');
        },
        { id: 's1' },
      );
      logger.info('after'); // outside the sub → untagged
      const phase = events.find((e) => e.phase === 'querying');
      const inside = events.find((e) => e.message === 'page 1');
      const outside = events.find((e) => e.message === 'after');
      expect(phase?.subId).toBe('s1');
      expect(inside?.subId).toBe('s1'); // grouped under the sub-process
      expect(outside?.subId).toBeUndefined(); // step-level log
    });
  });
});

describe('createStepLogger — heartbeat', () => {
  it('emits through the wire hook with the given progress, throttled to one per 5s window', () => {
    let t = 0;
    const beats: unknown[] = [];
    const events: StepEvent[] = [];
    const log = createStepLogger(
      events,
      () => t,
      (progress) => beats.push(progress),
    );

    log.heartbeat({ done: 1 }); // first call emits immediately
    t = 3_000;
    log.heartbeat({ done: 2 }); // inside the window → dropped
    t = 5_000;
    log.heartbeat({ done: 3 }); // window elapsed → emits
    t = 5_001;
    log.heartbeat(); // inside again → dropped

    expect(beats).toEqual([{ done: 1 }, { done: 3 }]);
    // Liveness is a wire signal, not a log line: nothing lands in the step's event trail.
    expect(events).toEqual([]);
  });

  it('is a safe no-op when no emitter is wired (local in-process steps)', () => {
    const log = createStepLogger([], at);
    expect(() => log.heartbeat({ done: 1 })).not.toThrow();
  });
});

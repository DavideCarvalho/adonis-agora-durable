import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { ScheduleAlreadyExistsError, ScheduleNotFoundError } from '../../src/schedules.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const T0 = Date.parse('2026-03-02T00:00:00.000Z'); // a Monday
const MIN = 60_000;

function setup(opts: { namespace?: string; store?: InMemoryStateStore } = {}) {
  const store = opts.store ?? new InMemoryStateStore();
  let now = T0;
  const engine = new WorkflowEngine({ store, clock: () => now, namespace: opts.namespace });
  engine.register('job', '1', async (_ctx, input) => input);
  engine.register('slow', '1', async (ctx) => ctx.waitForSignal('never'));
  return {
    store,
    engine,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('engine.schedules', () => {
  it('fires an interval schedule once per window and advances it', async () => {
    const { engine, store, at } = setup();
    const created = await engine.schedules.create({
      id: 'pulse',
      workflow: 'job',
      input: { n: 1 },
      every: '15m',
      tags: ['tenant:a'],
    });
    expect(created.nextFireAt?.getTime()).toBe(T0 + 15 * MIN);

    expect(await engine.schedules.tick(T0 + 14 * MIN)).toEqual([]);
    const fired = await engine.schedules.tick(T0 + 15 * MIN + 5_000);
    expect(fired).toEqual([`sched:pulse:${T0 + 15 * MIN}`]);
    // A second tick in the same window is a no-op: the schedule already moved on.
    expect(await engine.schedules.tick(T0 + 16 * MIN)).toEqual([]);

    const run = await store.getRun(fired[0] as string);
    expect(run?.input).toEqual({ n: 1 });
    expect(run?.tags).toEqual(['tenant:a', 'schedule:pulse']);
    const s = await engine.schedules.get('pulse');
    expect(s?.nextFireAt?.getTime()).toBe(T0 + 30 * MIN);
    expect(s?.lastRunId).toBe(fired[0]);
    expect(s?.fires).toBe(1);
    at(T0);
  });

  it('two schedulers racing on the same store start each window exactly once', async () => {
    const store = new InMemoryStateStore();
    const a = setup({ store });
    const b = setup({ store });
    await a.engine.schedules.create({ id: 'x', workflow: 'job', every: 60_000 });

    const [ra, rb] = await Promise.all([
      a.engine.schedules.tick(T0 + MIN),
      b.engine.schedules.tick(T0 + MIN),
    ]);
    expect([...ra, ...rb].every((id) => id === `sched:x:${T0 + MIN}`)).toBe(true);
    expect(await store.listRuns({ tag: 'schedule:x' })).toHaveLength(1);
    expect((await a.engine.schedules.get('x'))?.fires).toBe(1);
  });

  it("catches up only the latest missed window ('latest'), or none ('skip')", async () => {
    const { engine, store } = setup();
    await engine.schedules.create({ id: 'late', workflow: 'job', every: '5m' });
    await engine.schedules.create({ id: 'strict', workflow: 'job', every: '5m', catchup: 'skip' });

    // Nothing polled for ~50 minutes: the latest window (T0+50m) is 2 minutes old.
    const fired = await engine.schedules.tick(T0 + 52 * MIN);
    expect(fired).toEqual([`sched:late:${T0 + 50 * MIN}`]);
    expect(await store.listRuns({ tag: 'schedule:strict' })).toHaveLength(0);
    // Both are back on cadence.
    expect((await engine.schedules.get('strict'))?.nextFireAt?.getTime()).toBe(T0 + 55 * MIN);
    expect(await engine.schedules.tick(T0 + 55 * MIN)).toHaveLength(2);
  });

  it("overlap 'skip' skips a window while the previous run is in flight", async () => {
    const { engine } = setup();
    await engine.schedules.create({ id: 'o', workflow: 'slow', every: '1m', overlap: 'skip' });
    const [first] = await engine.schedules.tick(T0 + MIN);
    await engine.waitForRun(first as string);
    expect(await engine.schedules.tick(T0 + 2 * MIN)).toEqual([]);
    expect((await engine.schedules.get('o'))?.nextFireAt?.getTime()).toBe(T0 + 3 * MIN);
    await engine.cancel(first as string);
    expect(await engine.schedules.tick(T0 + 3 * MIN)).toEqual([`sched:o:${T0 + 3 * MIN}`]);
  });

  it('pause stops it; resume continues from the next window without catching up', async () => {
    const { engine, at } = setup();
    await engine.schedules.create({ id: 'p', workflow: 'job', every: '1m' });
    const paused = await engine.schedules.pause('p', 'vacation');
    expect(paused).toMatchObject({ paused: true, note: 'vacation', nextFireAt: null });
    expect(await engine.schedules.tick(T0 + 5 * MIN)).toEqual([]);

    at(T0 + 5 * MIN + 10_000);
    const resumed = await engine.schedules.resume('p');
    expect(resumed.nextFireAt?.getTime()).toBe(T0 + 6 * MIN);
    expect(await engine.schedules.tick(T0 + 5 * MIN + 20_000)).toEqual([]);
    expect(await engine.schedules.tick(T0 + 6 * MIN)).toHaveLength(1);
  });

  it('upsert replaces the definition, keeps history and a paused state; create refuses a taken id', async () => {
    const { engine } = setup();
    await engine.schedules.create({ id: 'u', workflow: 'job', every: '1m', input: 1 });
    await engine.schedules.tick(T0 + MIN);
    await engine.schedules.pause('u');
    await expect(
      engine.schedules.create({ id: 'u', workflow: 'job', every: '1m' }),
    ).rejects.toBeInstanceOf(ScheduleAlreadyExistsError);

    const u = await engine.schedules.upsert({ id: 'u', workflow: 'job', every: '5m', input: 2 });
    expect(u).toMatchObject({ paused: true, input: 2, everyMs: 5 * MIN, fires: 1 });
    expect(u.lastRunId).toBe(`sched:u:${T0 + MIN}`);
  });

  it('evaluates cron in its timezone, and triggers on demand', async () => {
    const { engine, store } = setup();
    // 09:00 in São Paulo (UTC-3) on weekdays = 12:00 UTC.
    const s = await engine.schedules.create({
      id: 'brief',
      workflow: 'job',
      cron: '0 9 * * 1-5',
      timezone: 'America/Sao_Paulo',
    });
    expect(s.nextFireAt?.toISOString()).toBe('2026-03-02T12:00:00.000Z');

    const manual = await engine.schedules.trigger('brief');
    expect(manual.runId).toBe(`sched:brief:manual:${T0}`);
    expect((await store.getRun(manual.runId))?.tags).toContain('schedule:brief');
    // A manual trigger doesn't move the cadence.
    expect((await engine.schedules.get('brief'))?.nextFireAt?.toISOString()).toBe(
      '2026-03-02T12:00:00.000Z',
    );
  });

  it('applies a stable jitter per window', async () => {
    const { engine } = setup();
    const s = await engine.schedules.create({
      id: 'j',
      workflow: 'job',
      every: '1h',
      jitter: '5m',
    });
    const next = s.nextFireAt?.getTime() as number;
    expect(next).toBeGreaterThanOrEqual(T0 + 60 * MIN);
    expect(next).toBeLessThan(T0 + 65 * MIN);
    // Not due before its jittered time; the run id is still the nominal window.
    if (next > T0 + 60 * MIN) expect(await engine.schedules.tick(next - 1)).toEqual([]);
    expect(await engine.schedules.tick(next)).toEqual([`sched:j:${T0 + 60 * MIN}`]);
  });

  it('records a failed start and moves on; rejects a bad definition up front', async () => {
    const { engine } = setup();
    await engine.schedules.create({ id: 'ghost', workflow: 'not-registered', every: '1m' });
    expect(await engine.schedules.tick(T0 + MIN)).toEqual([]);
    const s = await engine.schedules.get('ghost');
    expect(s?.lastError).toMatch(/not registered/);
    expect(s?.nextFireAt?.getTime()).toBe(T0 + 2 * MIN);

    await expect(
      engine.schedules.create({ id: 'both', workflow: 'job', every: '1m', cron: '* * * * *' }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      engine.schedules.create({ id: 'bad', workflow: 'job', cron: 'not a cron' }),
    ).rejects.toThrow();
    await expect(engine.schedules.pause('nope')).rejects.toBeInstanceOf(ScheduleNotFoundError);
  });

  it('lists by namespace/tag/workflow, fires only its own namespace, and deletes', async () => {
    const store = new InMemoryStateStore();
    const a = setup({ store, namespace: 'a' });
    const b = setup({ store, namespace: 'b' });
    await a.engine.schedules.create({ id: 'sa', workflow: 'job', every: '1m', tags: ['t'] });
    await b.engine.schedules.create({ id: 'sb', workflow: 'job', every: '1m' });

    expect((await a.engine.schedules.list({ namespace: 'a' })).map((s) => s.id)).toEqual(['sa']);
    expect((await a.engine.schedules.list({ tag: 't' })).map((s) => s.id)).toEqual(['sa']);
    expect((await a.engine.schedules.list()).map((s) => s.id)).toEqual(['sa', 'sb']);

    expect(await a.engine.schedules.tick(T0 + MIN)).toEqual([`sched:sa:${T0 + MIN}`]);
    expect((await store.getRun(`sched:sa:${T0 + MIN}`))?.namespace).toBe('a');

    expect(await a.engine.schedules.delete('sa')).toBe(true);
    expect(await a.engine.schedules.delete('sa')).toBe(false);
    expect(await a.engine.schedules.get('sa')).toBeNull();
  });
});

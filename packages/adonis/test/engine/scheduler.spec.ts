import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { runSchedules, type ScheduledWorkflow } from '../../src/scheduler.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** Fire schedules, then await each started window's run to settle (start now only enqueues). */
async function fireAndSettle(
  engine: WorkflowEngine,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
): Promise<string[]> {
  const ids = await runSchedules(engine, schedules, nowMs);
  for (const id of ids) await engine.waitForRun(id);
  return ids;
}

describe('runSchedules', () => {
  it('fires each time window exactly once (idempotent by bucket)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
      return 'tick';
    });
    const schedules = [{ key: 'beat', workflow: 'beat', everyMs: 1000 }];

    await fireAndSettle(engine, schedules, 1000); // bucket 1
    await fireAndSettle(engine, schedules, 1500); // same bucket → no duplicate
    expect(runs).toBe(1);

    await fireAndSettle(engine, schedules, 2000); // bucket 2 → fires again
    expect(runs).toBe(2);

    expect((await store.getRun('sched:beat:1'))?.output).toBe('tick');
    expect((await store.getRun('sched:beat:2'))?.output).toBe('tick');
  });

  it('reports only genuinely NEW windows (a re-tick over an existing bucket returns [])', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('beat', '1', async () => 'tick');
    const schedules = [{ key: 'beat', workflow: 'beat', everyMs: 1000 }];

    const first = await fireAndSettle(engine, schedules, 1000);
    expect(first).toEqual(['sched:beat:1']);

    // Same bucket, next worker tick: the window's run already exists — nothing fired, nothing
    // REPORTED. (Counting the idempotent no-op made `durable:work` log "1 scheduled" every tick
    // for the rest of the window.)
    const retick = await runSchedules(engine, schedules, 1500);
    expect(retick).toEqual([]);
  });

  it('skips a paused schedule', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
    });
    await fireAndSettle(
      engine,
      [{ key: 'b', workflow: 'beat', everyMs: 1000, paused: true }],
      1000,
    );
    expect(runs).toBe(0);
  });

  it('overlap:"skip" does not start a window while the previous run is still in-flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let started = 0;
    engine.register('slow', '1', async (ctx) => {
      await ctx.localStep('enter', async () => {
        started += 1; // once-only (checkpointed)
      });
      await ctx.waitForSignal('go'); // stays in-flight (suspended)
    });
    const sched = [{ key: 's', workflow: 'slow', everyMs: 1000, overlap: 'skip' as const }];

    await fireAndSettle(engine, sched, 1000); // bucket 1 → starts, suspends on signal
    expect(started).toBe(1);
    await fireAndSettle(engine, sched, 2000); // bucket 2 → prev (bucket 1) still in-flight → skip
    expect(started).toBe(1);

    await engine.signal('go', undefined); // bucket 1 completes
    await fireAndSettle(engine, sched, 3000); // bucket 3 → prev (bucket 2) never ran → starts
    expect(started).toBe(2);
  });

  it('fires a cron schedule once per scheduled time (idempotent within the interval)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('nightly', '1', async () => {
      runs += 1;
      return 'ran';
    });
    const schedules = [{ key: 'nightly', workflow: 'nightly', cron: '0 0 * * *', timezone: 'UTC' }];

    // 2026-01-01T05:00Z — the most recent midnight-UTC fire was 2026-01-01T00:00Z.
    const t1 = Date.UTC(2026, 0, 1, 5, 0, 0);
    await fireAndSettle(engine, schedules, t1);
    await fireAndSettle(engine, schedules, t1 + 3_600_000); // same day, before next midnight
    expect(runs).toBe(1);

    // Next day, just past midnight → a new fire time → fires again.
    const t2 = Date.UTC(2026, 0, 2, 0, 0, 1);
    await fireAndSettle(engine, schedules, t2);
    expect(runs).toBe(2);

    const fire1 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const fire2 = Date.UTC(2026, 0, 2, 0, 0, 0);
    expect((await store.getRun(`sched:nightly:${fire1}`))?.output).toBe('ran');
    expect((await store.getRun(`sched:nightly:${fire2}`))?.output).toBe('ran');
  });

  it('computes the cron fire time in the schedule timezone (not UTC)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('sp', '1', async () => 'ok');
    const schedules = [
      // Midnight in São Paulo (UTC−3, no DST since 2019) = 03:00Z.
      { key: 'sp', workflow: 'sp', cron: '0 0 * * *', timezone: 'America/Sao_Paulo' },
    ];

    // 2026-03-10T04:00Z is 01:00 in São Paulo → the day's fire (03:00Z) already passed.
    await fireAndSettle(engine, schedules, Date.UTC(2026, 2, 10, 4, 0, 0));
    const fire = Date.UTC(2026, 2, 10, 3, 0, 0); // 00:00 America/Sao_Paulo
    expect(await store.getRun(`sched:sp:${fire}`)).not.toBeNull();
  });

  it('start() is idempotent — re-triggering an existing run id is a no-op', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('once', '1', async () => {
      runs += 1;
      return runs;
    });
    const a = await startRun(engine, 'once', {}, 'fixed-id');
    const b = await startRun(engine, 'once', {}, 'fixed-id'); // redelivered trigger
    expect(runs).toBe(1);
    expect(b.status).toBe('completed');
    expect(a.output).toBe(b.output);
  });
});

describe('runSchedules — jitter', () => {
  it('delays the dispatch by up to the jitter bound before firing (never exceeds it)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('beat', '1', async () => 'tick');

    const sleeps: number[] = [];
    const ids = await runSchedules(
      engine,
      [{ key: 'b', workflow: 'beat', everyMs: 1000, jitter: 500 }],
      1000,
      {
        random: () => 0.5, // deterministic: half of the bound
        sleep: async (ms) => void sleeps.push(ms),
      },
    );

    expect(sleeps).toEqual([250]); // 0.5 * 500, applied before start
    expect(ids).toEqual(['sched:b:1']);
    await engine.waitForRun('sched:b:1');
    expect((await store.getRun('sched:b:1'))?.output).toBe('tick');
  });

  it('keeps the jittered delay within [0, jitter) for any random value', async () => {
    for (const rnd of [0, 0.1, 0.9, 0.999999]) {
      // Engine NOVO a cada iteração. Todas usam o mesmo `nowMs`, ou seja, a mesma
      // janela: reusando o engine, só a primeira teria algo a disparar, e o jitter
      // (que existe para espalhar disparos) corretamente não aconteceria nas outras.
      // O que este teste mede é a FAIXA do atraso, não a frequência dele.
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      engine.register('beat', '1', async () => 'tick');
      const sleeps: number[] = [];
      await runSchedules(
        engine,
        [{ key: 'b', workflow: 'beat', everyMs: 1000, jitter: 300 }],
        1000,
        {
          random: () => rnd,
          sleep: async (ms) => void sleeps.push(ms),
        },
      );
      expect(sleeps[0]).toBeGreaterThanOrEqual(0);
      expect(sleeps[0]).toBeLessThan(300);
    }
  });

  it('does not sleep when jitter is absent (default behavior preserved)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('beat', '1', async () => 'tick');
    const sleeps: number[] = [];
    await runSchedules(engine, [{ key: 'b', workflow: 'beat', everyMs: 1000 }], 1000, {
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([]);
  });
});

describe('runSchedules — backfill', () => {
  it('enqueues windows missed while the scheduler was down, up to maxCatchup', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
      return 'tick';
    });
    // Scheduler was down; now it's bucket 10. Backfill the 3 prior windows + the current one.
    const ids = await runSchedules(
      engine,
      [{ key: 'b', workflow: 'beat', everyMs: 1000, backfill: { maxCatchup: 3 } }],
      10_000,
    );
    for (const id of ids) await engine.waitForRun(id);

    expect(ids.sort()).toEqual(['sched:b:10', 'sched:b:7', 'sched:b:8', 'sched:b:9'].sort());
    expect(runs).toBe(4); // 3 backfilled + current
  });

  it('idempotent buckets prevent duplicates when backfill overlaps already-run windows', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
      return 'tick';
    });
    const sched = [{ key: 'b', workflow: 'beat', everyMs: 1000, backfill: { maxCatchup: 5 } }];

    await fireAndSettle(engine, sched, 8000); // backfills 3..8 (6 runs)
    expect(runs).toBe(6);

    // Next tick a window later — backfill range overlaps the already-run buckets → no duplicates.
    const ids = await fireAndSettle(engine, sched, 9000); // would cover 4..9; only 9 is new
    expect(ids).toContain('sched:b:9');
    expect(runs).toBe(7); // only the one genuinely-new window ran
  });

  it('caps backfilled windows at maxCatchup (does not flood from a long outage)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
    });
    // Huge gap, but maxCatchup:2 → only current + 2 prior windows.
    const ids = await fireAndSettle(
      engine,
      [{ key: 'b', workflow: 'beat', everyMs: 1000, backfill: { maxCatchup: 2 } }],
      1_000_000,
    );
    expect(ids).toHaveLength(3);
    expect(runs).toBe(3);
  });

  it('backfills a cron schedule by walking prior fire times, capped by maxCatchup', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('nightly', '1', async () => {
      runs += 1;
    });
    // Daily at midnight UTC, evaluated at 2026-01-10T05:00Z. Backfill 2 prior days + current.
    const ids = await fireAndSettle(
      engine,
      [
        {
          key: 'n',
          workflow: 'nightly',
          cron: '0 0 * * *',
          timezone: 'UTC',
          backfill: { maxCatchup: 2 },
        },
      ],
      Date.UTC(2026, 0, 10, 5, 0, 0),
    );
    expect(runs).toBe(3);
    const today = Date.UTC(2026, 0, 10, 0, 0, 0);
    const yest = Date.UTC(2026, 0, 9, 0, 0, 0);
    const before = Date.UTC(2026, 0, 8, 0, 0, 0);
    expect(ids.sort()).toEqual([`sched:n:${today}`, `sched:n:${yest}`, `sched:n:${before}`].sort());
  });
});

/**
 * O tick do worker roda a cada segundo, e o run id de um schedule é derivado da
 * JANELA de disparo — constante durante toda ela. Antes, cada tick perguntava ao
 * store por um id cuja resposta não podia ter mudado desde o tick anterior.
 *
 * Em produção isso deu ~28 `select … where id = ?` por SEGUNDO (14 schedules × 2
 * lookups × 2 pods), todos devolvendo a linha que o processo já tinha buscado.
 */
describe('runSchedules — custo por tick', () => {
  /** Um engine que conta os `getRun`, para medir I/O em vez de adivinhar. */
  function countingEngine(store: InMemoryStateStore) {
    const engine = new WorkflowEngine({ store });
    engine.register('beat', '1', async () => 'tick');
    let getRuns = 0;
    const original = engine.getRun.bind(engine);
    (engine as unknown as { getRun: typeof original }).getRun = async (id: string) => {
      getRuns += 1;
      return original(id);
    };
    return { engine, reads: () => getRuns };
  }

  it('tick seguinte na MESMA janela não vai ao store', async () => {
    const store = new InMemoryStateStore();
    const { engine, reads } = countingEngine(store);
    const schedules: ScheduledWorkflow[] = [{ key: 'b', workflow: 'beat', everyMs: 60_000 }];

    await runSchedules(engine, schedules, 60_000);
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    // Mais cinco ticks dentro da mesma janela de 60s.
    for (const t of [61_000, 62_000, 70_000, 80_000, 119_000]) {
      await runSchedules(engine, schedules, t);
    }
    expect(reads()).toBe(afterFirst);
  });

  it('janela NOVA volta a consultar o store', async () => {
    const store = new InMemoryStateStore();
    const { engine, reads } = countingEngine(store);
    const schedules: ScheduledWorkflow[] = [{ key: 'b', workflow: 'beat', everyMs: 60_000 }];

    await runSchedules(engine, schedules, 60_000);
    const afterFirst = reads();
    await runSchedules(engine, schedules, 120_000); // bucket seguinte
    expect(reads()).toBeGreaterThan(afterFirst);
  });

  it('processo NOVO consulta o store — é lá que a corrida entre workers é decidida', async () => {
    // A memoização só pode pular trabalho que ESTE processo viu acontecer. Um segundo
    // worker (engine novo sobre o mesmo store) não herda esse conhecimento, então ele
    // pergunta, descobre que a janela já rodou, e não dispara de novo.
    const store = new InMemoryStateStore();
    const first = countingEngine(store);
    const schedules: ScheduledWorkflow[] = [{ key: 'b', workflow: 'beat', everyMs: 60_000 }];

    const started = await runSchedules(first.engine, schedules, 60_000);
    expect(started).toHaveLength(1);

    const second = countingEngine(store);
    const again = await runSchedules(second.engine, schedules, 60_000);
    expect(again).toEqual([]);
    expect(second.reads()).toBeGreaterThan(0);
  });

  it('schedule pausado não custa I/O nenhum', async () => {
    const store = new InMemoryStateStore();
    const { engine, reads } = countingEngine(store);
    await runSchedules(engine, [{ key: 'b', workflow: 'beat', everyMs: 1000, paused: true }], 1000);
    expect(reads()).toBe(0);
  });

  it('overlap:skip só consulta a janela anterior quando há o que disparar', async () => {
    // Essa checagem custava um read por schedule por tick, mesmo sem nada para iniciar.
    const store = new InMemoryStateStore();
    const { engine, reads } = countingEngine(store);
    const schedules: ScheduledWorkflow[] = [
      { key: 'b', workflow: 'beat', everyMs: 60_000, overlap: 'skip' },
    ];

    await runSchedules(engine, schedules, 60_000);
    const afterFirst = reads();
    await runSchedules(engine, schedules, 61_000);
    expect(reads()).toBe(afterFirst);
  });
});

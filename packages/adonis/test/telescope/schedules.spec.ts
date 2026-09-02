import { describe, expect, it } from 'vitest';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { durableSchedules } from '../../src/telescope/schedules.js';
import type { ExtensionContext } from '../../src/telescope/telescope-sdk.js';

function makeCtx(engine: WorkflowEngine): ExtensionContext {
  return {
    store: { list: async () => [] },
    container: { make: async () => engine as never },
    config: {},
  };
}

function engineWith(schedules: Parameters<WorkflowEngine['registerSchedules']>[0]) {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  engine.registerSchedules(schedules);
  return engine;
}

/**
 * The whole point of this hook is that nobody retypes the schedule list: the engine
 * already knows what `@Scheduled` declared, so the console shows the decorators and
 * not a hand-kept copy that goes stale the first time a cron changes.
 */
describe('durableSchedules', () => {
  it('reporta um schedule de cron com expressão e timezone', async () => {
    const engine = engineWith([
      {
        key: 'sync-writing',
        workflow: 'SyncWriting',
        cron: '*/2 * * * *',
        timezone: 'America/Sao_Paulo',
      },
    ]);
    expect(await durableSchedules(makeCtx(engine))).toEqual([
      {
        name: 'sync-writing',
        kind: 'cron',
        schedule: '*/2 * * * *',
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });

  it('traduz everyMs para intervalo legível', async () => {
    const engine = engineWith([
      { key: 'a', workflow: 'A', everyMs: 120_000 },
      { key: 'b', workflow: 'B', everyMs: 3_600_000 },
      { key: 'c', workflow: 'C', everyMs: 45_000 },
    ]);
    const out = await durableSchedules(makeCtx(engine));
    expect(out.map((s) => s.schedule)).toEqual(['every 2m', 'every 1h', 'every 45s']);
    expect(out.every((s) => s.kind === 'interval')).toBe(true);
  });

  it('schedule pausado AINDA aparece', async () => {
    // Omitir um job pausado é como alguém perde uma tarde procurando um cron que
    // "sumiu": o console mostra o que existe, não o que está rodando agora.
    const engine = engineWith([{ key: 'pausado', workflow: 'P', cron: '0 * * * *', paused: true }]);
    expect((await durableSchedules(makeCtx(engine))).map((s) => s.name)).toEqual(['pausado']);
  });

  it('sem schedules descobertos devolve lista vazia', async () => {
    expect(await durableSchedules(makeCtx(engineWith([])))).toEqual([]);
  });
});

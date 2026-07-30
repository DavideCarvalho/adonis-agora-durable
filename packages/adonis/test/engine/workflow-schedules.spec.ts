import { describe, expect, it } from 'vitest';
import { Scheduled, workflowSchedules } from '../../src/workflow-ref.js';

describe('workflowSchedules (colocated `static schedule` reader)', () => {
  it('normalizes a single schedule object, defaulting key to the workflow name', () => {
    class BulaCrawlCoordinatorWorkflow {
      static workflow = { name: 'bula-crawl-coordinator', version: '1' };
      static schedule = { cron: '0 4 * * *', timezone: 'America/Sao_Paulo' };
      async run() {
        return 'ok';
      }
    }
    expect(workflowSchedules(BulaCrawlCoordinatorWorkflow)).toEqual([
      {
        workflow: 'bula-crawl-coordinator',
        key: 'bula-crawl-coordinator',
        cron: '0 4 * * *',
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });

  it('normalizes an array of schedules, defaulting keys to `${name}:${i}`', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = [{ everyMs: 60_000 }, { cron: '0 * * * *' }];
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'sync:0', everyMs: 60_000 },
      { workflow: 'sync', key: 'sync:1', cron: '0 * * * *' },
    ]);
  });

  it('preserves an explicit key', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = { everyMs: 60_000, key: 'nightly' };
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'nightly', everyMs: 60_000 },
    ]);
  });

  it('preserves explicit keys inside an array', () => {
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = [{ everyMs: 60_000, key: 'fast' }, { cron: '0 * * * *' }];
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'fast', everyMs: 60_000 },
      // no explicit key → `${name}:${i}` derived from array position (still stable)
      { workflow: 'sync', key: 'sync:1', cron: '0 * * * *' },
    ]);
  });

  it('returns [] for a class with `static workflow` but no `static schedule`', () => {
    class PlainWorkflow {
      static workflow = { name: 'plain' };
      async run() {}
    }
    expect(workflowSchedules(PlainWorkflow)).toEqual([]);
  });

  it('returns [] for a class with `static schedule` but no `static workflow` (not registrable)', () => {
    class Orphan {
      static schedule = { everyMs: 1000 };
      async run() {}
    }
    expect(workflowSchedules(Orphan)).toEqual([]);
  });

  it('returns [] for a non-class value', () => {
    expect(workflowSchedules(undefined)).toEqual([]);
    expect(workflowSchedules({})).toEqual([]);
    expect(workflowSchedules('sync')).toEqual([]);
  });

  it('derives a DETERMINISTIC default key: same class name → same key across calls', () => {
    class CoordinatorWorkflow {
      static workflow = { name: 'coordinator' };
      static schedule = { cron: '0 4 * * *' };
      async run() {}
    }
    const first = workflowSchedules(CoordinatorWorkflow);
    const second = workflowSchedules(CoordinatorWorkflow);
    expect(first[0]?.key).toBe('coordinator');
    expect(second[0]?.key).toBe(first[0]?.key);
  });
});

describe('@Scheduled (decorator form of the colocated schedule)', () => {
  it('stamps a single schedule, behaving exactly like `static schedule` (key = workflow name)', () => {
    @Scheduled({ cron: '0 4 * * *', timezone: 'America/Sao_Paulo' })
    class CrawlWorkflow {
      static workflow = { name: 'crawl' };
      async run() {}
    }
    expect(workflowSchedules(CrawlWorkflow)).toEqual([
      { workflow: 'crawl', key: 'crawl', cron: '0 4 * * *', timezone: 'America/Sao_Paulo' },
    ]);
  });

  it('accepts an array, keyed positionally like the static form', () => {
    @Scheduled([{ everyMs: 60_000 }, { cron: '0 * * * *' }])
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'sync:0', everyMs: 60_000 },
      { workflow: 'sync', key: 'sync:1', cron: '0 * * * *' },
    ]);
  });

  it('repeated applications accumulate in SOURCE order (top decorator first)', () => {
    @Scheduled({ everyMs: 60_000, key: 'fast' })
    @Scheduled({ cron: '0 * * * *', key: 'hourly' })
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'fast', everyMs: 60_000 },
      { workflow: 'sync', key: 'hourly', cron: '0 * * * *' },
    ]);
  });

  it('composes with an existing `static schedule` (decorator first, literal after)', () => {
    @Scheduled({ everyMs: 60_000, key: 'fast' })
    class SyncWorkflow {
      static workflow = { name: 'sync' };
      static schedule = { cron: '0 * * * *', key: 'hourly' };
      async run() {}
    }
    expect(workflowSchedules(SyncWorkflow)).toEqual([
      { workflow: 'sync', key: 'fast', everyMs: 60_000 },
      { workflow: 'sync', key: 'hourly', cron: '0 * * * *' },
    ]);
  });

  it('a decorated class without `static workflow` is still not registrable (schedules ignored)', () => {
    @Scheduled({ everyMs: 1000 })
    class Orphan {
      async run() {}
    }
    expect(workflowSchedules(Orphan)).toEqual([]);
  });

  it('does not leak the subclass stamp onto a decorated base class', () => {
    class BaseSync {
      static workflow = { name: 'base-sync' };
      static schedule = { cron: '0 * * * *', key: 'hourly' };
      async run() {}
    }
    @Scheduled({ everyMs: 60_000, key: 'fast' })
    class FastSync extends BaseSync {
      static override workflow = { name: 'fast-sync' };
    }
    // The subclass accumulates (decorator + inherited literal); the base class stays untouched.
    expect(workflowSchedules(FastSync)).toEqual([
      { workflow: 'fast-sync', key: 'fast', everyMs: 60_000 },
      { workflow: 'fast-sync', key: 'hourly', cron: '0 * * * *' },
    ]);
    expect(workflowSchedules(BaseSync)).toEqual([
      { workflow: 'base-sync', key: 'hourly', cron: '0 * * * *' },
    ]);
  });
});

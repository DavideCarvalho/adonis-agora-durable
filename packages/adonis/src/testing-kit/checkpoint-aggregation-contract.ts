import { expect } from 'vitest';
import {
  aggregatesCheckpoints,
  type CheckpointStat,
  checkpointStatsOf,
  childIdsOf,
  type FanPageQuery,
  pageFan,
  pageFanFromStore,
  queryCheckpointsOf,
  runDetailEtag,
  type StateStore,
  type StepCheckpoint,
  SUMMARY_CHILD_LIMIT,
  summarizeRunFromStore,
  summarizeTimeline,
  type WorkflowRun,
} from '../index.js';

const base = Date.parse('2026-06-11T00:00:00.000Z');
const ms = (n: number) => new Date(base + n);

function cp(seq: number, over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq,
    name: 'Lines.process',
    kind: 'remote',
    stepId: `r1:${seq}`,
    status: 'completed',
    output: { n: seq },
    attempts: 1,
    enqueuedAt: ms(seq * 10),
    startedAt: ms(seq * 10 + 3),
    finishedAt: ms(seq * 10 + 7),
    ...over,
  };
}

const child = (seq: number, group: string, over: Partial<StepCheckpoint> = {}) =>
  cp(seq, {
    name: `signal:child:r1.all.${group.split(':')[1]}.${seq}`,
    kind: 'signal',
    parallelGroup: group,
    output: { ok: true, value: seq },
    ...over,
  });

const folded = (seq: number, group: string, wave: number, from: number, n: number) =>
  cp(seq, {
    name: `fan:r1.all.${group.split(':')[1]}.w${wave}.`,
    kind: 'signal',
    parallelGroup: group,
    output: { from, values: Array.from({ length: n }, (_, i) => i) },
  });

/**
 * One run carrying every shape a run detail has to summarize: ungrouped steps and a spawn edge, a
 * step fan wide by rows, a narrow step fan, a step fan sent in partial waves (wide by its declared
 * size), a failFast fan with mixed step names, a child fan in flight with failed children of both
 * kinds plus a folded wave, a child fan that is mostly folded (one fold standing for no child), a
 * narrow child fan with a failure, and a child fan whose group predates the declared size.
 */
export function aggregationFixture(): StepCheckpoint[] {
  const rows: StepCheckpoint[] = [cp(0, { name: 'Lines.load', kind: 'local' })];
  rows.push(cp(1, { name: 'spawn:audit-1', kind: 'local', output: 'audit-1' }));
  // Step fan, wide by rows: 25 failed (retried), 20 pending, 2 running.
  for (let i = 0; i < 120; i++) {
    const seq = 2 + i;
    rows.push(
      cp(seq, {
        parallelGroup: 'steps:2:120',
        ...(i % 4 === 0 && i < 100
          ? { status: 'failed', attempts: 3, error: { message: `bad ${i}` } }
          : i >= 100 && i < 120 && i !== 105 && i !== 106
            ? { status: 'pending', output: undefined }
            : i === 105 || i === 106
              ? { status: 'running', output: undefined }
              : {}),
      }),
    );
  }
  for (let i = 0; i < 5; i++) rows.push(cp(122 + i, { parallelGroup: 'steps:122:5' }));
  for (let i = 0; i < 30; i++) {
    rows.push(
      cp(127 + i, {
        parallelGroup: 'steps:127:40000',
        name: 'Rows.score',
        ...(i >= 12 ? { status: 'pending', output: undefined } : {}),
      }),
    );
  }
  for (let i = 0; i < 30; i++) {
    rows.push(
      cp(157 + i, {
        parallelGroup: 'steps:157:60:failFast',
        name: i % 2 === 0 ? 'Check.a' : 'Check.b',
        ...(i === 7 ? { status: 'failed', error: { message: 'stop' } } : {}),
      }),
    );
  }
  // Child fan in flight: placeholders, successes, `ok: false` completions and failed rows, and a
  // folded wave standing for 20 children.
  for (let i = 0; i < 60; i++) {
    const seq = 187 + i;
    rows.push(
      child(seq, 'all:187:n80', {
        ...(i >= 50
          ? { status: 'running', output: undefined }
          : i % 3 === 0
            ? { output: { ok: false, error: `child ${i}` } }
            : i % 7 === 1
              ? { status: 'failed', error: { message: 'lost' } }
              : {}),
      }),
    );
  }
  rows.push(folded(247, 'all:187:n80', 9, 60, 20));
  // A child fan mostly folded: few rows, declared wide; one fold stands for no child at all.
  rows.push(folded(300, 'all:300:n3000:failFast', 0, 0, 1000));
  rows.push(folded(301, 'all:300:n3000:failFast', 1, 1000, 1000));
  rows.push(folded(302, 'all:300:n3000:failFast', 2, 2000, 0));
  for (let i = 0; i < 4; i++) {
    rows.push(child(303 + i, 'all:300:n3000:failFast', { status: 'running', output: undefined }));
  }
  rows.push(child(400, 'all:400:n3'));
  rows.push(child(401, 'all:400:n3', { output: { ok: false, error: 'narrow' } }));
  rows.push(child(402, 'all:400:n3', { status: 'running', output: undefined }));
  for (let i = 0; i < 55; i++) {
    rows.push(child(450 + i, 'all:450', i === 54 ? { output: { ok: false } } : {}));
  }
  rows.push(cp(600, { name: 'Lines.report', kind: 'local', status: 'failed' }));
  return rows;
}

const GROUPS = [
  'steps:2:120',
  'steps:122:5',
  'steps:127:40000',
  'steps:157:60:failFast',
  'all:187:n80',
  'all:300:n3000:failFast',
  'all:400:n3',
  'all:450',
  'absent',
];

const QUERIES: FanPageQuery[] = [
  {},
  { offset: 10, limit: 7 },
  { offset: 0, limit: 500 },
  { offset: 118, limit: 50 },
  { offset: 5000 },
  { failedOnly: true },
  { failedOnly: true, offset: 3, limit: 4 },
  { failedOnly: true, offset: 15, limit: 10 },
  { failedOnly: true, offset: 1000 },
];

/** The buckets, with names reduced to whether a bucket is uniform: a database's collation decides
 *  which of two names is "smaller", so only that equality is portable across stores. */
function comparable(stats: CheckpointStat[]) {
  return stats
    .map(({ minName, maxName, ...rest }) => ({ ...rest, uniform: minName === maxName }))
    .sort((a, b) =>
      `${a.group}|${a.status}|${a.nameKind}`.localeCompare(`${b.group}|${b.status}|${b.nameKind}`),
    );
}

async function seed(store: StateStore, run: (over?: Partial<WorkflowRun>) => WorkflowRun) {
  await store.createRun(run());
  for (const row of aggregationFixture()) await store.saveCheckpoint(row);
  // Another run sharing a group name: every read must stay scoped to its run.
  await store.createRun(run({ id: 'r2' }));
  for (let i = 0; i < 3; i++) {
    await store.saveCheckpoint(
      cp(2 + i, { runId: 'r2', stepId: `r2:${i}`, parallelGroup: 'steps:2:120', status: 'failed' }),
    );
  }
}

/**
 * The contract of the optional checkpoint aggregation pair (`checkpointStats` + `queryCheckpoints`):
 * each agrees with its in-memory reference, and the run detail built on them is identical to the
 * one `summarizeTimeline` / `pageFan` build from the whole checkpoint list.
 */
export function registerCheckpointAggregationCases(
  t: (label: string, fn: () => Promise<void>) => void,
  getStore: () => StateStore,
  run: (over?: Partial<WorkflowRun>) => WorkflowRun,
): void {
  t('checkpointStats and queryCheckpoints agree with the in-memory reference', async () => {
    const store = getStore();
    expect(store.checkpointStats).toBeDefined();
    expect(store.queryCheckpoints).toBeDefined();
    if (!aggregatesCheckpoints(store)) return;
    await seed(store, run);
    const full = await store.listCheckpoints('r1');

    expect(comparable(await store.checkpointStats('r1'))).toEqual(
      comparable(checkpointStatsOf(full)),
    );
    for (const group of GROUPS) {
      expect(comparable(await store.checkpointStats('r1', { group }))).toEqual(
        comparable(checkpointStatsOf(full, { group })),
      );
    }
    expect(await store.checkpointStats('nope')).toEqual([]);

    const queries = [
      {},
      { group: 'steps:2:120' },
      { group: 'steps:2:120', statuses: ['failed' as const], limit: 20 },
      { group: 'steps:2:120', offset: 30, limit: 5 },
      { group: 'all:187:n80', statuses: ['completed' as const], namePrefixes: ['signal:child:'] },
      { excludeGroups: ['steps:2:120', 'all:187:n80', 'all:450'] },
      { excludeGroups: [] },
      { namePrefixes: ['signal:child:', 'fan:', 'spawn:'], offset: 200, limit: 200 },
      { namePrefixes: ['fan:'] },
      { statuses: [] },
      { namePrefixes: [] },
      { statuses: ['pending' as const, 'running' as const], offset: 3 },
    ];
    for (const query of queries) {
      expect(await store.queryCheckpoints('r1', query)).toEqual(queryCheckpointsOf(full, query));
    }
  });

  t('a run detail read through the aggregates is the one summarizeTimeline builds', async () => {
    const store = getStore();
    if (!aggregatesCheckpoints(store)) return;
    await seed(store, run);
    const full = await store.listCheckpoints('r1');
    for (const over of [50, 0, 1000]) {
      const ids = [...new Set(childIdsOf(full))];
      const expected = {
        ...summarizeTimeline(full, over),
        children: ids.slice(0, SUMMARY_CHILD_LIMIT),
        childCount: ids.length,
      };
      expect(await summarizeRunFromStore(store, 'r1', over)).toEqual(expected);
    }
  });

  t('a fan page read through the aggregates is the one pageFan builds', async () => {
    const store = getStore();
    if (!aggregatesCheckpoints(store)) return;
    await seed(store, run);
    const full = await store.listCheckpoints('r1');
    for (const group of GROUPS) {
      for (const query of QUERIES) {
        expect(await pageFanFromStore(store, 'r1', group, query)).toEqual(
          pageFan(full, group, query),
        );
      }
    }
  });

  t('the run-detail etag moves with every checkpoint write', async () => {
    const store = getStore();
    if (!aggregatesCheckpoints(store)) return;
    await seed(store, run);
    const r1 = (await store.getRun('r1')) as WorkflowRun;
    const etag = async () => runDetailEtag(r1, await store.checkpointStats('r1'), 50);
    const before = await etag();
    expect(await etag()).toBe(before);
    // A pending step of the wide fan settles: its bucket moves.
    const target = (await store.getCheckpoint('r1', 103)) as StepCheckpoint;
    await store.saveCheckpoint({ ...target, status: 'completed', output: { n: 103 } });
    const settled = await etag();
    expect(settled).not.toBe(before);
    // A retried step: only its attempts move.
    await store.saveCheckpoint({ ...target, status: 'completed', attempts: target.attempts + 1 });
    expect(await etag()).not.toBe(settled);
  });
}

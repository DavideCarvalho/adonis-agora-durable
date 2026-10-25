import { describe, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { createDurableTables, DURABLE_TABLES } from '../../src/stores/lucid-schema.js';
import { makeIsolatedMysqlDb } from '../support/mysql.js';

/**
 * Opt-in cost harness, not a regression test: the buffered-signal sweep and the child-completion
 * check on the Lucid store over a real MySQL, against the table shape of a deployment where the sweep
 * held the worker tick. One 40k-child `ctx.all` parent (still running, its 40k checkpoints present)
 * with 20k of its children's completions buffered, 22k more buffered completions of other runs,
 * ~380k checkpoints and ~167k runs overall. Prints one `HARNESS {...}` line: one sweep tick (time,
 * statements, rows the server read), the full drain, and the write-path check per completion. Not
 * part of the suite:
 *
 *   DURABLE_HARNESS=1 DURABLE_MYSQL_URL=mysql://root:root@127.0.0.1:3306 \
 *   npx vitest run test/harness/buffered-sweep
 *
 * Knobs: H_FAN (40000) the wide parent's children, H_ORPHANS (20000) its buffered rows,
 * H_OTHER_BUFFERED (22000), H_RUNS (167000) other runs, H_CHECKPOINTS (340000) other checkpoints,
 * H_DRAIN (1) `0` to skip the full drain.
 */
const ON = process.env.DURABLE_HARNESS === '1';
const MYSQL = process.env.DURABLE_MYSQL_URL;
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const fan = num('H_FAN', 40_000);
const orphans = num('H_ORPHANS', 20_000);
const otherBuffered = num('H_OTHER_BUFFERED', 22_000);
const otherRuns = num('H_RUNS', 167_000);
const otherCheckpoints = num('H_CHECKPOINTS', 340_000);
const drain = num('H_DRAIN', 1) === 1;

const PARENT = '01a15edf-0000-4000-8000-000000000000';
const CHUNK = 2_000;

const childValue = (i: number) => ({ line: i, rows: [i, i + 1, i + 2], note: 'x'.repeat(64) });

describe.skipIf(!ON || !MYSQL)('buffered-signal sweep on Lucid/MySQL (harness)', () => {
  it(`one tick over ${orphans + otherBuffered} buffered rows, ${fan}-child parent`, async () => {
    const db = await makeIsolatedMysqlDb(MYSQL as string);
    try {
      await createDurableTables(db);
      const at = Date.now();
      const insert = async <T>(table: string, n: number, make: (i: number) => T) => {
        for (let from = 0; from < n; from += CHUNK) {
          const rows: T[] = [];
          for (let i = from; i < Math.min(n, from + CHUNK); i += 1) rows.push(make(i));
          await db
            .insertQuery()
            .table(table)
            .multiInsert(rows as Record<string, unknown>[]);
        }
      };
      const run = (id: string, status: string) => ({
        id,
        workflow: 'load',
        workflow_version: '1',
        status,
        namespace: 'default',
        input: '{}',
        created_at: at,
        updated_at: at,
      });
      const checkpoint = (runId: string, seq: number, name: string, output: unknown) => ({
        run_id: runId,
        seq,
        name,
        kind: 'signal',
        step_id: `${runId}:${seq}`,
        status: 'completed',
        output: JSON.stringify(output),
        attempts: 1,
        parallel_group: 'all:0:n100',
        started_at: at,
        finished_at: at,
      });

      const seedStarted = Date.now();
      await insert(DURABLE_TABLES.runs, 1, () => run(PARENT, 'running'));
      await insert(DURABLE_TABLES.runs, otherRuns, (i) =>
        run(`run-${i}`, i % 3 === 0 ? 'suspended' : 'completed'),
      );
      await insert(DURABLE_TABLES.checkpoints, fan, (i) =>
        checkpoint(PARENT, i, `signal:child:${PARENT}.all.0.${i}`, {
          ok: true,
          value: childValue(i),
        }),
      );
      await insert(DURABLE_TABLES.checkpoints, otherCheckpoints, (i) =>
        checkpoint(`run-${i % otherRuns}`, Math.floor(i / otherRuns), `step-${i}`, { i }),
      );
      // The wide parent's completions first (the oldest rows), then those of other runs: roots,
      // children of finished parents, children of live parents that never settled them.
      await insert(DURABLE_TABLES.bufferedSignals, orphans, (i) => {
        const child = fan - orphans + i;
        return {
          token: `child:${PARENT}.all.0.${child}`,
          payload: JSON.stringify({ ok: true, value: childValue(child) }),
        };
      });
      await insert(DURABLE_TABLES.bufferedSignals, otherBuffered, (i) => ({
        token: i % 2 === 0 ? `child:root-${i}` : `child:run-${i % otherRuns}.child.${i}`,
        payload: JSON.stringify({ ok: true, value: i }),
      }));
      await db.rawQuery(`analyze table ${Object.values(DURABLE_TABLES).join(', ')}`);
      const seedMs = Date.now() - seedStarted;

      let statements = 0;
      const clients = new Set([db.connection().getWriteClient(), db.connection().getReadClient()]);
      for (const client of clients) {
        client.on('query', () => {
          statements += 1;
        });
      }
      const rowsRead = async (): Promise<number> => {
        const [rows] = (await db.rawQuery("SHOW GLOBAL STATUS LIKE 'Handler_read%'")) as [
          { Value: string }[],
        ];
        return rows.reduce((sum, row) => sum + Number(row.Value), 0);
      };
      const measure = async <T>(work: () => Promise<T>) => {
        const r0 = await rowsRead();
        const s0 = statements;
        const t0 = performance.now();
        const result = await work();
        const ms = Math.round(performance.now() - t0);
        const sent = statements - s0;
        return { ms, statements: sent, rowsRead: (await rowsRead()) - r0, result };
      };

      const store = new LucidStateStore(db);
      await store.getCheckpoint(PARENT, 0);
      const engine = new WorkflowEngine({ store });
      const tick = await measure(() => engine.sweepBufferedSignals());

      let fullDrain: { ms: number; ticks: number; deleted: number; left: number } | undefined;
      if (drain) {
        const t0 = performance.now();
        let ticks = 1;
        let deleted = tick.result;
        const internals = engine as unknown as { bufferedSweepCursor?: string };
        while (internals.bufferedSweepCursor !== undefined && ticks < 10_000) {
          deleted += await engine.sweepBufferedSignals();
          ticks += 1;
        }
        const [[{ left }]] = (await db.rawQuery(
          `select count(*) as \`left\` from ${DURABLE_TABLES.bufferedSignals}`,
        )) as [[{ left: number }]];
        fullDrain = {
          ms: Math.round(performance.now() - t0) + tick.ms,
          ticks,
          deleted,
          left: Number(left),
        };
      }

      // The write path: a duplicate notification for a settled child of the wide parent.
      const deliver = engine as unknown as {
        deliverToParent(token: string, completion: unknown): Promise<void>;
      };
      const calls = 200;
      const write = await measure(async () => {
        for (let k = 0; k < calls; k += 1) {
          const i = (k * 197) % fan;
          await deliver.deliverToParent(`child:${PARENT}.all.0.${i}`, {
            ok: true,
            value: childValue(i),
          });
        }
      });

      process.stdout.write(
        `HARNESS ${JSON.stringify({
          seedMs,
          oneTick: {
            ms: tick.ms,
            statements: tick.statements,
            rowsRead: tick.rowsRead,
            deleted: tick.result,
          },
          fullDrain,
          writePathPerCompletion: {
            ms: +(write.ms / calls).toFixed(2),
            statements: +(write.statements / calls).toFixed(2),
            rowsRead: Math.round(write.rowsRead / calls),
          },
        })}\n`,
      );
    } finally {
      await db.manager.closeAll();
    }
  }, 3_600_000);
});

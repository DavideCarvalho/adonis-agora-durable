import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDurableTables } from '../../src/stores/lucid-schema.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { makeIsolatedPostgresDb } from '../../src/transports/db-helpers.js';
import { deleteRedisKeys, uniqueRedisPrefix } from '../support/backends.js';

/**
 * Opt-in throughput harness: many trivial ONE-step runs over the BullMQ transport and the Redis control
 * plane on real Postgres + Redis, shaped like an app fleet — "web" pods starting runs round-robin and
 * worker pods running the step handler plus the `durable:work` loop, each its own PROCESS
 * (`one-step-pod.ts`), so the engines do not share one event loop. Prints runs/s and how many step
 * executions were duplicates. `H_KILL=1` SIGKILLs one web pod and one worker once `H_KILL_AT` (0.15)
 * of the runs completed, as a crashed fleet. Not part of the suite:
 *
 *   DURABLE_HARNESS=1 DURABLE_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *   DURABLE_REDIS_URL=redis://127.0.0.1:6379 npx vitest run test/harness/one-step-throughput
 *
 * Knobs: H_RUNS (2000), H_WEB (3), H_WORKERS (2), H_CHUNK (50 starts per request), H_POOL (10),
 * H_KILL, H_KILL_AT.
 */
const ON = process.env.DURABLE_HARNESS === '1';
const PG = process.env.DURABLE_PG_URL;
const REDIS = process.env.DURABLE_REDIS_URL ?? process.env.REDIS_URL;
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const POD = fileURLToPath(new URL('./one-step-pod.ts', import.meta.url));
const REGISTER = fileURLToPath(new URL('../support/register-ts.mjs', import.meta.url));

interface Pod {
  id: string;
  proc: ChildProcess;
  alive: boolean;
  request(msg: unknown, until: (reply: Record<string, unknown>) => boolean): Promise<void>;
}

function spawnPod(config: Record<string, unknown>): Promise<Pod> {
  const proc = fork(POD, [JSON.stringify(config)], {
    execArgv: ['--import', REGISTER],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const pod: Pod = {
    id: config.id as string,
    proc,
    alive: true,
    request: (msg, until) =>
      new Promise((resolve, reject) => {
        const onMessage = (reply: Record<string, unknown>) => {
          if (!until(reply)) return;
          proc.off('message', onMessage);
          proc.off('exit', onExit);
          resolve();
        };
        const onExit = () => {
          proc.off('message', onMessage);
          reject(new Error(`pod ${pod.id} exited`));
        };
        if (!proc.connected) {
          pod.alive = false;
          reject(new Error(`pod ${pod.id} is gone`));
          return;
        }
        proc.on('message', onMessage);
        proc.once('exit', onExit);
        proc.send(msg as never, (err) => {
          if (!err) return;
          pod.alive = false;
          proc.off('message', onMessage);
          proc.off('exit', onExit);
          reject(err);
        });
      }),
  };
  proc.once('exit', () => {
    pod.alive = false;
  });
  // A send racing the pod's death reports through its callback; never crash the harness over it.
  proc.on('error', () => {
    pod.alive = false;
  });
  return new Promise((resolve, reject) => {
    proc.once('message', () => resolve(pod));
    proc.once('exit', (code) => reject(new Error(`pod ${pod.id} exited during boot (${code})`)));
  });
}

describe.skipIf(!ON || !PG || !REDIS)('one-step run throughput harness (Postgres + BullMQ)', () => {
  it(
    'runs many one-step runs across a fleet of processes and reports runs/s',
    async () => {
      const runs = num('H_RUNS', 2000);
      const chunk = num('H_CHUNK', 50);
      const kill = process.env.H_KILL === '1';
      const killAt = Math.floor(runs * num('H_KILL_AT', 0.15));
      const prefix = uniqueRedisPrefix('tputfix');
      const schemaDb = await makeIsolatedPostgresDb(PG as string);
      await createDurableTables(schemaDb);
      const base = {
        pg: PG,
        schema: schemaDb.schemaName,
        redis: REDIS,
        prefix,
        pool: num('H_POOL', 10),
      };
      const deps = await createBullMQDeps(REDIS as string);
      const redis = deps.makeRedis() as unknown as Parameters<typeof deleteRedisKeys>[0] & {
        hgetall(key: string): Promise<Record<string, string>>;
        quit(): Promise<unknown>;
      };
      const pods: Pod[] = [];
      try {
        const workers = await Promise.all(
          Array.from({ length: num('H_WORKERS', 2) }, (_, i) =>
            spawnPod({ ...base, id: `worker-${i}`, role: 'worker' }),
          ),
        );
        const web = await Promise.all(
          Array.from({ length: num('H_WEB', 3) }, (_, i) =>
            spawnPod({ ...base, id: `web-${i}`, role: 'web' }),
          ),
        );
        pods.push(...workers, ...web);
        const completedCount = async () => {
          const row = (await schemaDb
            .from('durable_workflow_runs')
            .where('status', 'completed')
            .count('* as n')
            .first()) as { n: string | number };
          return Number(row.n);
        };
        await web[0]?.request({ start: ['warmup'], request: 'warmup' }, (r) => 'started' in r);
        while ((await completedCount()) < 1) await new Promise((r) => setTimeout(r, 20));

        const startedAt = Date.now();
        let killed = !kill;
        let next = 0;
        let rr = 0;
        // Round-robin load balancer: each "request" starts a chunk of runs on the next live web pod.
        const starter = async () => {
          while (next < runs) {
            const from = next;
            next = Math.min(runs, next + chunk);
            const ids = Array.from({ length: next - from }, (_, k) => `r-${from + k}`);
            const request = `${from}`;
            for (;;) {
              const live = web.filter((p) => p.alive);
              const pod = live[rr++ % live.length] as Pod;
              try {
                await pod.request({ start: ids, request }, (r) => r.started === request);
                break;
              } catch {
                // That pod died mid-request: the LB retries it on another (start is idempotent).
              }
            }
          }
        };
        const starting = Promise.all(Array.from({ length: web.length * 2 }, starter));
        const deadline = Date.now() + 15 * 60_000;
        let completed = 0;
        let killedAt = 0;
        let lastCompleted = -1;
        let lastProgressAt = Date.now();
        while (Date.now() < deadline) {
          completed = (await completedCount()) - 1;
          if (!killed && completed >= killAt) {
            killed = true;
            killedAt = Date.now() - startedAt;
            web[0]?.proc.kill('SIGKILL');
            workers[0]?.proc.kill('SIGKILL');
          }
          if (completed >= runs) break;
          // Stalled for a while: say which runs are stuck, and on what (H_DIAG=1).
          if (process.env.H_DIAG === '1' && completed !== lastCompleted) {
            lastCompleted = completed;
            lastProgressAt = Date.now();
          } else if (process.env.H_DIAG === '1' && Date.now() - lastProgressAt > 15_000) {
            lastProgressAt = Date.now();
            const stuck = await schemaDb
              .from('durable_workflow_runs as r')
              .leftJoin('durable_step_checkpoints as c', 'c.run_id', 'r.id')
              .whereNot('r.status', 'completed')
              .select(
                'r.id',
                'r.status',
                'r.locked_by',
                'r.locked_until',
                'r.wake_at',
                'r.wake_requested_at',
                'r.updated_at',
                'c.status as step',
                'c.attempts',
                'c.enqueued_at',
              )
              .limit(10);
            const at = Date.now();
            process.stdout.write(
              `[one-step-throughput] stuck at ${completed}: ${JSON.stringify(
                stuck.map((r: Record<string, unknown>) => ({
                  ...r,
                  locked_until: r.locked_until == null ? null : Number(r.locked_until) - at,
                  wake_at: r.wake_at == null ? null : Number(r.wake_at) - at,
                  updated_at: Number(r.updated_at) - at,
                  enqueued_at: r.enqueued_at == null ? null : Number(r.enqueued_at) - at,
                })),
              )}\n`,
            );
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        await starting;
        const finishedAt = Date.now();
        expect(completed).toBe(runs);
        await new Promise((r) => setTimeout(r, 500));
        let duplicates = 0;
        let duplicatedRuns = 0;
        const duplicated: string[] = [];
        const executions = await redis.hgetall(`${prefix}:executions`);
        for (const [runId, v] of Object.entries(executions)) {
          if (Number(v) > 1) {
            duplicates += Number(v) - 1;
            duplicatedRuns += 1;
            duplicated.push(runId);
          }
        }
        const report = {
          runs,
          totalMs: finishedAt - startedAt,
          runsPerSec: Math.round((runs / (finishedAt - startedAt)) * 10_000) / 10,
          duplicates,
          duplicatedRuns,
          ...(kill
            ? {
                killedAtMs: killedAt,
                // Which worker ran each duplicated step: once on the killed worker and once on a
                // survivor is BullMQ re-running the killed worker's active job (inherent); twice on
                // survivors is a second job.
                duplicated: Object.fromEntries(
                  Object.entries(await redis.hgetall(`${prefix}:executions-by-worker`))
                    .filter(([key]) => duplicated.includes(key.split('|')[0] as string))
                    .slice(0, 100),
                ),
              }
            : {}),
        };
        process.stdout.write(`[one-step-throughput] ${JSON.stringify(report)}\n`);
      } finally {
        await Promise.all(
          pods
            .filter((p) => p.alive)
            .map(
              (p) =>
                new Promise<void>((resolve) => {
                  const t = setTimeout(() => {
                    p.proc.kill('SIGKILL');
                    resolve();
                  }, 15_000);
                  p.proc.once('exit', () => {
                    clearTimeout(t);
                    resolve();
                  });
                  p.proc.send({ stop: true });
                }),
            ),
        );
        await deleteRedisKeys(redis, prefix);
        await redis.quit();
        await schemaDb.manager.closeAll();
      }
    },
    30 * 60_000,
  );
});

/**
 * Dispatched-step bench: engine processes sharing BullMQ, with separate step-worker processes, on a
 * real Postgres (Lucid store) and Redis. Every workflow step is a dispatched `ctx.step`, so a step's
 * result can land on any engine. Reports wf/s, SQL statements per step (engines only), engine CPU per
 * workflow, and the sticky hit rate when the engine has a sticky cache.
 *
 *   pnpm exec tsc -p tsconfig.build.json   # the bench runs the built dist/, not the sources
 *   node bench/dispatched-steps.mjs <engines=1> [workers=4] [scenario=throughput|long]
 *
 * Env: DURABLE_PG_URL, DURABLE_REDIS_URL, BENCH_WF (1000), BENCH_POOL (per engine, 10),
 * BENCH_STEP_CONCURRENCY (per worker, 16), BENCH_LONG_STEPS (1000), BENCH_ROOT (another checkout's
 * `packages/adonis`, built, to bench it with this script: an A/B against a baseline), BENCH_SQL_LOG=1
 * (each engine prints its statements by text), BENCH_PROF=<dir> (engines write a V8 CPU profile).
 *
 * Not part of the suite (nothing here is a spec); run it by hand, never alongside the test suite.
 */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = pathToFileURL(
  `${process.env.BENCH_ROOT ? resolve(process.env.BENCH_ROOT) : fileURLToPath(new URL('..', import.meta.url))}/`,
);
const pg = createRequire(new URL('package.json', root))('pg');
const dist = (path) => import(new URL(`dist/src/${path}`, root).href);
const { WorkflowEngine } = await dist('engine.js');
const { createDurableTables } = await dist('stores/lucid-schema.js');
const { LucidStateStore } = await dist('stores/lucid.js');
const { BullMQTransport } = await dist('transports/bullmq/bullmq-transport.js');
const { createBullMQDeps } = await dist('transports/bullmq/deps.js');
const { makePostgresDb } = await dist('transports/db-helpers.js');

const PG_URL = process.env.DURABLE_PG_URL ?? 'postgres://postgres:pg@127.0.0.1:55871/durable';
const REDIS_URL = process.env.DURABLE_REDIS_URL ?? 'redis://127.0.0.1:56871';
const WF = Number(process.env.BENCH_WF ?? 1000);
const POOL = Number(process.env.BENCH_POOL ?? 10);
const STEP_CONCURRENCY = Number(process.env.BENCH_STEP_CONCURRENCY ?? 16);
const LONG_STEPS = Number(process.env.BENCH_LONG_STEPS ?? 1000);
const PREFIX = 'agoraperf';
const SCHEMA = 'agoraperf';
const STEPS = ['bench.s1', 'bench.s2', 'bench.s3', 'bench.s4', 'bench.s5', 'bench.now'];

let statements = 0;
// BENCH_SQL_LOG=1: each engine prints its statements by text (most frequent first) when it stops.
const sqlLog = process.env.BENCH_SQL_LOG === '1' ? new Map() : undefined;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  statements += 1;
  if (sqlLog) {
    const q = args[0];
    const text = (typeof q === 'string' ? q : (q?.text ?? '?')).slice(0, 160);
    sqlLog.set(text, (sqlLog.get(text) ?? 0) + 1);
  }
  return origQuery.apply(this, args);
};

const send = (msg) => process.send?.(msg);

async function makeTransport(id, opts = {}) {
  const deps = await createBullMQDeps(REDIS_URL);
  return new BullMQTransport({ deps, prefix: PREFIX, instanceId: id, ...opts });
}

const role = process.argv[2];
if (role === '--worker') {
  const t = await makeTransport(`w-${process.pid}`, { concurrency: STEP_CONCURRENCY });
  for (const name of STEPS) {
    t.handle(name, async (input) => (name === 'bench.now' ? Date.now() : input + 1));
  }
  send('ready');
  process.on('message', async (m) => {
    if (m === 'stop') {
      await t.close();
      process.exit(0);
    }
  });
} else if (role === '--engine') {
  const db = makePostgresDb(PG_URL, SCHEMA, POOL);
  const id = `e-${process.pid}`;
  const t = await makeTransport(id);
  const engine = new WorkflowEngine({
    store: new LucidStateStore(db),
    transport: t,
    instanceId: id,
    reconcileMs: 60_000,
  });
  engine.register('five', '1', async (ctx, input) => {
    let last = 0;
    for (let i = 1; i <= 5; i += 1) last = await ctx.step(`bench.s${i}`, last);
    return { i: input.i, last };
  });
  engine.register('long', '1', async (ctx, input) => {
    const stamps = [];
    for (let i = 0; i < input.n; i += 1) stamps.push(await ctx.step('bench.now', i));
    return stamps;
  });
  engine.consumeRuns();
  send('ready');
  let c0;
  process.on('message', async (m) => {
    if (m === 'stop') {
      const u = process.cpuUsage(c0);
      if (sqlLog) {
        const top = [...sqlLog].sort((a, b) => b[1] - a[1]).slice(0, 40);
        for (const [text, n] of top) console.log(String(n).padStart(6), text);
      }
      const sticky = engine.sticky;
      send({
        statements,
        hits: sticky?.hits ?? 0,
        misses: sticky?.misses ?? 0,
        cpuMs: (u.user + u.system) / 1000,
      });
      await engine.drain(5000).catch(() => undefined);
      await t.close();
      await db.manager.closeAll();
      process.exit(0);
    }
    statements = 0;
    sqlLog?.clear();
    c0 = process.cpuUsage();
    const { workflow, ids, inputs, starters } = m.go;
    let next = 0;
    await Promise.all(
      Array.from({ length: starters }, async () => {
        while (next < ids.length) {
          const i = next++;
          await engine.start(workflow, inputs[i], ids[i]).catch((e) => console.error(e));
        }
      }),
    );
  });
} else {
  const engines = Number(process.argv[2] ?? 1);
  const workers = Number(process.argv[3] ?? 4);
  const scenario = process.argv[4] ?? 'throughput';
  const deps = await createBullMQDeps(REDIS_URL);
  const redis = deps.makeRedis();
  await redis.flushall();
  await redis.quit();
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  {
    const db = makePostgresDb(PG_URL, SCHEMA, 2);
    await createDurableTables(db);
    await db.manager.closeAll();
  }
  const self = fileURLToPath(import.meta.url);
  // BENCH_PROF=<dir>: the engines write a V8 CPU profile there when they exit.
  const prof = process.env.BENCH_PROF;
  const spawn = async (r) => {
    const execArgv =
      prof && r === '--engine'
        ? [...process.execArgv, '--cpu-prof', `--cpu-prof-dir=${prof}`]
        : process.execArgv;
    const child = fork(self, [r], { env: process.env, execArgv });
    await new Promise((res) => child.once('message', res));
    return child;
  };
  const ws = await Promise.all(Array.from({ length: workers }, () => spawn('--worker')));
  const es = await Promise.all(Array.from({ length: engines }, () => spawn('--engine')));
  const t0 = performance.now();
  let ids;
  if (scenario === 'throughput') {
    ids = Array.from({ length: WF }, (_, i) => `five-${i}`);
    es.forEach((e, k) => {
      const mine = ids.filter((_, i) => i % engines === k);
      e.send({
        go: {
          workflow: 'five',
          ids: mine,
          inputs: mine.map((_, i) => ({ i })),
          starters: Math.ceil(32 / engines),
        },
      });
    });
  } else {
    ids = ['long-1'];
    es[0]?.send({ go: { workflow: 'long', ids, inputs: [{ n: LONG_STEPS }], starters: 1 } });
  }
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('failed','dead','cancelled'))::int AS bad FROM ${SCHEMA}.durable_workflow_runs WHERE workflow IN ('five', 'long')`,
    );
    if (rows[0].bad > 0) throw new Error(`${rows[0].bad} runs failed`);
    const { rows: done } = await admin.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.durable_workflow_runs WHERE status = 'completed' AND workflow IN ('five', 'long')`,
    );
    if (done[0].n >= ids.length) break;
    if (Date.now() > deadline) throw new Error(`timed out at ${done[0].n}/${ids.length}`);
    await new Promise((res) => setTimeout(res, 20));
  }
  const ms = performance.now() - t0;
  const reports = await Promise.all(
    es.map(
      (e) =>
        new Promise((res) => {
          e.once('message', res);
          e.send('stop');
        }),
    ),
  );
  for (const w of ws) w.send('stop');
  const steps = scenario === 'throughput' ? WF * 5 : LONG_STEPS;
  const sum = (k) => reports.reduce((a, r) => a + (r[k] ?? 0), 0);
  const out = {
    sqlPerStep: Number((sum('statements') / steps).toFixed(2)),
    stickyHitPct: Number(((100 * sum('hits')) / steps).toFixed(1)),
    engineCpuMsPerWf: Number((sum('cpuMs') / (scenario === 'throughput' ? WF : 1)).toFixed(2)),
  };
  if (scenario === 'throughput') out.wfPerSec = Number(((WF * 1000) / ms).toFixed(1));
  else {
    const { rows } = await admin.query(
      `SELECT output FROM ${SCHEMA}.durable_workflow_runs WHERE id = 'long-1'`,
    );
    const raw = rows[0].output;
    const stamps = typeof raw === 'string' ? JSON.parse(raw) : raw;
    out.totalMs = Number(ms.toFixed(0));
    out.msPerStep = Number(((stamps.at(-1) - stamps[0]) / (stamps.length - 1)).toFixed(2));
    const q = Math.floor(stamps.length / 4);
    // Per-step cost over the first and last quarter: constant when a step does not replay history.
    out.msPerStepFirstQuarter = Number(((stamps[q] - stamps[0]) / q).toFixed(2));
    out.msPerStepLastQuarter = Number(
      ((stamps.at(-1) - stamps[stamps.length - 1 - q]) / q).toFixed(2),
    );
  }
  console.log(`agora e${engines} w${workers} ${scenario}`, JSON.stringify(out));
  await admin.end();
  process.exit(0);
}

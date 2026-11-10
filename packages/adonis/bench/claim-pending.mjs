/**
 * Pending-run pickup bench, no broker: a backlog of `pending` five-localStep workflows on Postgres,
 * drained by N engine processes polling `runPending`. Reports wf/s and SQL statements per workflow.
 *
 *   pnpm exec tsc -p tsconfig.build.json
 *   node bench/claim-pending.mjs <processes=1>
 *
 * Env: DURABLE_PG_URL, BENCH_WF (1000), BENCH_POOL (per process, 10), BENCH_PREPARED=1 (the store
 * sends its hot statements as named prepared statements), BENCH_ROOT (another checkout's
 * `packages/adonis`, built, for an A/B). Not part of the suite.
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
const { makePostgresDb } = await dist('transports/db-helpers.js');

const PG_URL = process.env.DURABLE_PG_URL ?? 'postgres://postgres:pg@127.0.0.1:55871/durable';
const WF = Number(process.env.BENCH_WF ?? 1000);
const POOL = Number(process.env.BENCH_POOL ?? 10);
const SCHEMA = 'agoraclaim';

let statements = 0;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  statements += 1;
  return origQuery.apply(this, args);
};

const idle = { dispatch: () => undefined };
function engineOn(db) {
  const engine = new WorkflowEngine({
    store: new LucidStateStore(db, { preparedStatements: process.env.BENCH_PREPARED === '1' }),
    runDispatcher: idle,
    reconcileMs: 60_000,
  });
  engine.register('five', '1', async (ctx) => {
    let last = 0;
    for (let i = 1; i <= 5; i += 1) last = await ctx.localStep(`s${i}`, async () => last + 1);
    return last;
  });
  return engine;
}

if (process.argv[2] === '--poller') {
  const db = makePostgresDb(PG_URL, SCHEMA, POOL);
  const engine = engineOn(db);
  process.send?.('ready');
  process.on('message', async (m) => {
    if (m !== 'go') return;
    statements = 0;
    for (;;) {
      const ran = await engine.runPending();
      if (ran.length === 0) {
        const { rows } = await db.rawQuery(
          `select count(*)::int as n from durable_workflow_runs where status <> 'completed'`,
        );
        if (rows[0].n === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    process.send?.({ statements });
    await db.manager.closeAll();
    process.exit(0);
  });
} else {
  const processes = Number(process.argv[2] ?? 1);
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await origQuery.call(admin, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  const db = makePostgresDb(PG_URL, SCHEMA, 4);
  await createDurableTables(db);
  const starter = engineOn(db);
  for (let i = 0; i < WF; i += 1) await starter.start('five', {}, `w${i}`);
  await db.manager.closeAll();
  const self = fileURLToPath(import.meta.url);
  const pollers = await Promise.all(
    Array.from({ length: processes }, async () => {
      const child = fork(self, ['--poller'], { env: process.env });
      await new Promise((res) => child.once('message', res));
      return child;
    }),
  );
  const t0 = performance.now();
  const reports = await Promise.all(
    pollers.map(
      (p) =>
        new Promise((res) => {
          p.once('message', res);
          p.send('go');
        }),
    ),
  );
  const ms = performance.now() - t0;
  const { rows } = await origQuery.call(
    admin,
    `SELECT count(*)::int AS n FROM ${SCHEMA}.durable_workflow_runs WHERE status = 'completed'`,
  );
  if (rows[0].n !== WF) throw new Error(`${rows[0].n}/${WF} completed`);
  const sql = reports.reduce((a, r) => a + r.statements, 0);
  console.log(
    `agora claim p${processes}`,
    JSON.stringify({
      wfPerSec: Number(((WF * 1000) / ms).toFixed(1)),
      sqlPerWf: Number((sql / WF).toFixed(1)),
    }),
  );
  await admin.end();
  process.exit(0);
}

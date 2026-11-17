/**
 * Task-queue layout bench: Redis commands of one engine + worker "pod" serving N step handlers, per
 * second while idle and per run of a three-step workflow, for `taskQueues: 'per-handler'` and
 * `'grouped'`.
 *
 * Commands are counted from `INFO commandstats` deltas, which count every command a Lua script runs
 * as well as the `EVALSHA` itself: the number a per-command billed Redis (Upstash) charges. The
 * bench's own `INFO` / `CONFIG` calls are left out. The store is in-memory SQLite, so every counted
 * command is the transport's (queues, registry, reply routing, heartbeats).
 *
 *   pnpm exec tsc -p tsconfig.build.json   # the bench runs the built dist/, not the sources
 *   DURABLE_REDIS_URL=redis://127.0.0.1:16399 node bench/task-queue-layout.mjs <per-handler|grouped>
 *
 * Env: BENCH_HANDLERS (85), BENCH_IDLE_S (60), BENCH_RUNS (20), BENCH_STALLED_MS (BullMQ's default),
 * BENCH_ROOT (another checkout's `packages/adonis`, built: an A/B against a baseline). The Redis is
 * FLUSHALLed first: point it at a throwaway instance. Not part of the suite; run it by hand.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = pathToFileURL(
  `${process.env.BENCH_ROOT ? resolve(process.env.BENCH_ROOT) : fileURLToPath(new URL('..', import.meta.url))}/`,
);
const dist = (path) => import(new URL(`dist/src/${path}`, root).href);
const { WorkflowEngine } = await dist('engine.js');
const { createDurableTables } = await dist('stores/lucid-schema.js');
const { LucidStateStore } = await dist('stores/lucid.js');
const { BullMQTransport } = await dist('transports/bullmq/bullmq-transport.js');
const { createBullMQDeps } = await dist('transports/bullmq/deps.js');
const { makeMemoryDb } = await dist('transports/db-helpers.js');
const { Redis } = createRequire(new URL('package.json', root))('ioredis');

const REDIS_URL = process.env.DURABLE_REDIS_URL ?? 'redis://127.0.0.1:16399';
const LAYOUT = process.argv[2] ?? 'per-handler';
const HANDLERS = Number(process.env.BENCH_HANDLERS ?? 85);
const IDLE_S = Number(process.env.BENCH_IDLE_S ?? 60);
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const STALLED_MS = process.env.BENCH_STALLED_MS ? Number(process.env.BENCH_STALLED_MS) : undefined;

const admin = new Redis(REDIS_URL);
await admin.flushall();

/** Sum of every command's calls since the last reset, without the bench's own INFO/CONFIG. */
async function commandCount() {
  const info = await admin.info('commandstats');
  let total = 0;
  const byCmd = {};
  for (const line of info.split('\n')) {
    const m = /^cmdstat_([^:]+):calls=(\d+)/.exec(line.trim());
    if (!m || m[1] === 'info' || m[1].startsWith('config')) continue;
    total += Number(m[2]);
    byCmd[m[1]] = Number(m[2]);
  }
  return { total, byCmd };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = makeMemoryDb();
await createDurableTables(db);
const deps = await createBullMQDeps(
  REDIS_URL,
  1,
  undefined,
  STALLED_MS !== undefined ? { stalledInterval: STALLED_MS } : {},
);
const transport = new BullMQTransport({
  deps,
  prefix: 'layoutbench',
  instanceId: 'pod-1',
  // The registry as recommended once a fleet is on rc.32 (no compatibility keys or walks).
  workerRegistry: { legacyWrites: false, legacyScan: false },
  ...(LAYOUT === 'grouped' ? { taskQueues: 'grouped' } : {}),
});
const engine = new WorkflowEngine({
  store: new LucidStateStore(db),
  transport,
  instanceId: 'pod-1',
  reconcileMs: 60_000,
});
for (let i = 0; i < HANDLERS; i += 1) {
  transport.handle(`bench.h${i}`, async (input) => (input ?? 0) + 1);
}
engine.register('three', '1', async (ctx) => {
  let v = 0;
  for (let i = 0; i < 3; i += 1) v = await ctx.step(`bench.h${i}`, v);
  return v;
});
engine.consumeRuns();

// Warm-up: let every worker connect, run its first stalled check and settle into its idle loop.
await sleep(15_000);
await admin.config('RESETSTAT');
const t0 = performance.now();
await sleep(IDLE_S * 1000);
const idle = await commandCount();
const idleSeconds = (performance.now() - t0) / 1000;
const idleRate = idle.total / idleSeconds;

// Runs: one at a time, the idle background over the same wall time subtracted.
await admin.config('RESETSTAT');
const r0 = performance.now();
for (let i = 0; i < RUNS; i += 1) {
  const id = `three-${i}`;
  await engine.start('three', {}, id);
  for (;;) {
    const run = await engine.getRun(id);
    if (run && (run.status === 'completed' || run.status === 'failed')) {
      if (run.status !== 'completed') throw new Error(`run ${id} ${run.status}`);
      break;
    }
    await sleep(5);
  }
}
const runSeconds = (performance.now() - r0) / 1000;
const runs = await commandCount();
const perRun = (runs.total - idleRate * runSeconds) / RUNS;

const top = Object.entries(idle.byCmd)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([cmd, n]) => `${cmd}=${(n / idleSeconds).toFixed(2)}`)
  .join(' ');
console.log(
  JSON.stringify({
    layout: LAYOUT,
    root: process.env.BENCH_ROOT ?? 'this checkout',
    handlers: HANDLERS,
    stalledInterval: STALLED_MS ?? 'default (30s)',
    idleCmdPerSec: Number(idleRate.toFixed(2)),
    idleTop: top,
    commandsPerRun: Number(perRun.toFixed(1)),
    runTop: Object.entries(runs.byCmd)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cmd, n]) => `${cmd}=${(n / RUNS).toFixed(1)}`)
      .join(' '),
    msPerRun: Number(((runSeconds * 1000) / RUNS).toFixed(1)),
    clients: (await admin.info('clients')).match(/connected_clients:(\d+)/)?.[1],
  }),
);
await engine.drain?.(5_000).catch(() => undefined);
await transport.close();
await db.manager.closeAll();
await admin.quit();
process.exit(0);

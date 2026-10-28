/**
 * One pod of the one-step throughput harness (`one-step-throughput.harness.spec.ts`), run as its own
 * process: `node --import ./test/support/register-ts.mjs test/harness/one-step-pod.ts '<json config>'`.
 * A `web` pod starts the runs it is sent; a `worker` pod runs the step handler and the `durable:work`
 * loop. Every step execution is counted in a Redis hash, so a SIGKILLed worker's count survives it.
 */
import { runWorkerLoop } from '../../src/commands/worker.js';
import { RedisControlPlane } from '../../src/control-plane-redis/redis-control-plane.js';
import { WorkflowEngine } from '../../src/engine.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { makePostgresDb } from '../../src/transports/db-helpers.js';

interface PodConfig {
  id: string;
  role: 'web' | 'worker';
  pg: string;
  schema: string;
  redis: string;
  prefix: string;
  pool: number;
}

export const HARNESS_STEP = 'harness.echo';

const config = JSON.parse(process.argv[2] as string) as PodConfig;
const send = (msg: unknown) => process.send?.(msg);

const db = makePostgresDb(config.pg, config.schema, config.pool);
const deps = await createBullMQDeps(config.redis);
const transport = new BullMQTransport({ deps, prefix: config.prefix, instanceId: config.id });
const cpRedis = deps.makeRedis() as never;
const controlPlane = new RedisControlPlane({
  connection: cpRedis,
  prefix: config.prefix,
  pingIntervalMs: false,
});
const engine = new WorkflowEngine({
  store: new LucidStateStore(db),
  transport,
  controlPlane,
  instanceId: config.id,
});
engine.register('Test', '1', async (ctx) => ctx.step(HARNESS_STEP, { id: ctx.runId }));

let stop!: () => void;
const stopSignal = new Promise<void>((resolve) => {
  stop = resolve;
});
let loop: Promise<unknown> = Promise.resolve();
if (config.role === 'worker') {
  const counter = deps.makeRedis() as unknown as {
    hincrby(key: string, field: string, by: number): Promise<number>;
  };
  transport.handle(HARNESS_STEP, async (input) => {
    const id = (input as { id: string }).id;
    await counter.hincrby(`${config.prefix}:executions`, id, 1);
    await counter.hincrby(`${config.prefix}:executions-by-worker`, `${id}|${config.id}`, 1);
    return input;
  });
  loop = runWorkerLoop(engine, {
    intervalMs: 1000,
    drainTimeoutMs: 5000,
    stopSignal,
    logger: { info: () => {}, error: (m) => console.error(`[${config.id}] ${m}`) },
  });
}

process.on('message', async (msg: { start?: string[]; request?: string; stop?: true }) => {
  if (msg.start) {
    const ids = msg.start;
    let next = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next < ids.length) {
          const id = ids[next] as string;
          next += 1;
          await engine.start('Test', {}, id).catch((err) => console.error(err));
        }
      }),
    );
    send({ started: msg.request });
  }
  if (msg.stop) {
    stop();
    await loop.catch(() => undefined);
    await engine.drain(5_000).catch(() => undefined);
    await transport.close().catch(() => undefined);
    (cpRedis as { disconnect(): void }).disconnect();
    await db.manager.closeAll().catch(() => undefined);
    process.exit(0);
  }
});
send({ ready: true });

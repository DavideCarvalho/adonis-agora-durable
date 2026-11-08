import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';

/**
 * CROWN-JEWEL cross-ecosystem interop proof (store-less cluster design §11): an Adonis control-plane
 * `WorkflowEngine` dispatches a durable `ctx.step('py-echo', …)` onto the aviary BullMQ wire, a REAL
 * aviary (`nestjs-durable`) Python worker consumes it off `${P}-tasks-py-echo`, executes it, and
 * publishes the result on `${P}-results` — which resumes the Adonis run to `completed` with the value
 * Python computed. This proves the wire is byte-compatible across ecosystems over a real Redis.
 *
 * GATED (skips cleanly in CI — no Redis/Python/bullmq needed):
 *   - `DURABLE_INTEROP_REDIS_URL` — the live Redis (required; the whole suite skips without it).
 *   - `DURABLE_INTEROP_PYTHON`    — path to the Python interpreter with `durable-worker[redis]`
 *                                   installed. When set, the spec SPAWNS the worker itself. When
 *                                   unset, it assumes a worker is already consuming `py-echo` on the
 *                                   same prefix (started out-of-band) and just waits for it to appear.
 *
 * Run (from packages/adonis, with a live Redis + the venv from clients/python):
 *   DURABLE_INTEROP_REDIS_URL=redis://localhost:6379 \
 *   DURABLE_INTEROP_PYTHON=/abs/path/to/clients/python/.venv/bin/python \
 *     node_modules/.bin/vitest run test/interop
 */
const REDIS_URL = process.env.DURABLE_INTEROP_REDIS_URL;
const PYTHON = process.env.DURABLE_INTEROP_PYTHON;

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = resolve(HERE, 'py_echo_worker.py');

const closers: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of closers) await Promise.resolve(c()).catch(() => {});
});

/** Poll `fn` until it returns truthy or the deadline passes; throws with `label` on timeout. */
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!REDIS_URL)('Adonis control-plane -> Python worker interop (real Redis)', () => {
  it('dispatches a step the Python worker executes and resumes the run to completed', async () => {
    const prefix = `durable-interop-${Date.now()}`;
    // ioredis options take `host`/`port` (NOT a `url` key), so parse the URL into the shape both
    // bullmq's Queue/Worker connection and the transport's own `makeRedis()` (SCAN/heartbeat) accept.
    const parsed = new URL(REDIS_URL as string);
    const connection = { host: parsed.hostname, port: Number(parsed.port || 6379) } as unknown;

    // --- Adonis side: engine (control-plane) wired to the aviary BullMQ transport --------------
    const transport = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'adonis-cp',
    });
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport, instanceId: 'adonis-cp' });
    closers.push(() => transport.close());

    // The workflow owns a single durable step named `py-echo` — a step NAME the Python worker owns.
    engine.register('py-interop', '1', async (ctx) => {
      const out = await ctx.step<{ echoed: unknown; runtime: string; nPlusOne: number }>(
        'py-echo',
        {
          n: 41,
        },
      );
      return out;
    });

    // --- Python side: spawn the REAL aviary worker (or expect an external one) -----------------
    let worker: ChildProcess | undefined;
    const workerLog: string[] = [];
    if (PYTHON) {
      worker = spawn(PYTHON, [WORKER_SCRIPT, prefix], {
        env: { ...process.env, DURABLE_INTEROP_REDIS_URL: REDIS_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      worker.stdout?.on('data', (b: Buffer) => workerLog.push(`[py-out] ${b.toString().trim()}`));
      worker.stderr?.on('data', (b: Buffer) => workerLog.push(`[py-err] ${b.toString().trim()}`));
      const w = worker;
      closers.push(
        () =>
          new Promise<void>((res) => {
            w.once('exit', () => res());
            w.kill('SIGTERM');
            setTimeout(() => {
              w.kill('SIGKILL');
              res();
            }, 3000);
          }),
      );
    }

    // Wait until the Python worker advertises a LIVE `py-echo` group (its TTL'd heartbeat key), read
    // via the SAME transport SCAN the control-plane uses — first cross-ecosystem read of the wire.
    await waitFor(
      `python worker to register the 'py-echo' group\n${workerLog.join('\n')}`,
      async () => (await transport.listWorkerGroups()).includes('py-echo'),
      20_000,
    );

    // The Python worker's handshake descriptor, published on `${P}-worker-descriptor:py-echo:*` and
    // read back + JSON-parsed by the Adonis transport — proving the descriptor bytes cross-read.
    const descriptors = await transport.listWorkerDescriptors('py-echo');
    const pyDescriptor = descriptors.find((d) => d.runtime === 'python');
    expect(
      pyDescriptor,
      `expected a python worker descriptor, got ${JSON.stringify(descriptors)}`,
    ).toBeDefined();
    expect(pyDescriptor?.steps).toContain('py-echo');

    // --- Drive it: start the run; the step suspends, the Python result resumes it --------------
    const started = await startRun(engine, 'py-interop', {}, 'interop-run-1');
    expect(started.status).toBe('suspended');

    const run = await waitFor(
      `run to complete\n${workerLog.join('\n')}`,
      async () => {
        const r = await store.getRun('interop-run-1');
        return r && r.status !== 'running' && r.status !== 'suspended' ? r : undefined;
      },
      20_000,
    );

    // --- ASSERT: the run completed with the value the PYTHON worker computed --------------------
    expect(run.status, `run failed: ${JSON.stringify(run.error)}\n${workerLog.join('\n')}`).toBe(
      'completed',
    );
    expect(run.output).toEqual({
      echoed: { n: 41 },
      runtime: 'python',
      sdk: 'durable-worker',
      nPlusOne: 42,
    });

    // The checkpoint proves the step was DISPATCHED (remote) and routed to the `py-echo` token.
    const checkpoints = await store.listCheckpoints('interop-run-1');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.kind).toBe('remote');
    expect(checkpoints[0]?.status).toBe('completed');
    expect(checkpoints[0]?.name).toBe('py-echo');
    expect(checkpoints[0]?.workerGroup).toBe('py-echo');

    // --- Live wire evidence: capture the actual BullMQ Redis keys both ecosystems shared --------
    const require = createRequire(import.meta.url);
    const { Redis } = require('ioredis') as { Redis: new (url: string) => any };
    const raw = new Redis(REDIS_URL as string);
    closers.push(() => raw.disconnect());
    const bullKeys: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = (await raw.scan(cursor, 'MATCH', 'bull:*', 'COUNT', 200)) as [
        string,
        string[],
      ];
      cursor = next;
      bullKeys.push(...keys);
    } while (cursor !== '0');
    const shared = bullKeys.filter((k) => k.includes(prefix)).sort();
    // Both the task queue (Adonis -> Python) and the results queue (Python -> Adonis) exist under the
    // one `bull:` keyspace, under the SAME prefix — the byte-level shared wire.
    expect(shared.some((k) => k.startsWith(`bull:${prefix}-tasks-py-echo:`))).toBe(true);
    expect(shared.some((k) => k.startsWith(`bull:${prefix}-results:`))).toBe(true);

    // Surface the evidence in the test output so a live run documents itself.
    // eslint-disable-next-line no-console
    console.log(
      [
        '--- CROSS-ECOSYSTEM WIRE EVIDENCE ---',
        `prefix: ${prefix}`,
        `python descriptor: ${JSON.stringify(pyDescriptor)}`,
        `run.output (computed in Python): ${JSON.stringify(run.output)}`,
        `shared bull keys:\n  ${shared.join('\n  ')}`,
      ].join('\n'),
    );
  }, 60_000);

  // A Python worker that routes results (durable-worker with `ResultPublisher`) sends each step's
  // result back to the Adonis engine that dispatched it, which holds the body parked on the step: with
  // two engines, every body runs once. An older worker sends them to the shared queue, and the runs
  // still complete (replaying where the result landed), so only the completion is asserted then.
  it.skipIf(!PYTHON)(
    'routes each result back to the engine that dispatched the step, with two engines',
    async () => {
      const prefix = `durable-interop-rr-${Date.now()}`;
      const parsed = new URL(REDIS_URL as string);
      const connection = { host: parsed.hostname, port: Number(parsed.port || 6379) } as unknown;
      const store = new InMemoryStateStore({ roundTripMethods: true });
      let entries = 0;
      const engines = await Promise.all(
        ['adonis-a', 'adonis-b'].map(async (id) => {
          const transport = new BullMQTransport({
            deps: await createBullMQDeps(connection),
            prefix,
            instanceId: id,
          });
          closers.push(() => transport.close());
          const engine = new WorkflowEngine({ store, transport, instanceId: id, reconcileMs: 0 });
          engine.register('py-seq', '1', async (ctx) => {
            entries += 1;
            let n = 0;
            for (let i = 0; i < 4; i += 1) {
              n = (await ctx.step<{ nPlusOne: number }>('py-echo', { n })).nPlusOne;
            }
            return n;
          });
          return { engine, transport };
        }),
      );
      const worker = spawn(PYTHON as string, [WORKER_SCRIPT, prefix], {
        env: { ...process.env, DURABLE_INTEROP_REDIS_URL: REDIS_URL },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const workerLog: string[] = [];
      worker.stderr?.on('data', (b: Buffer) => workerLog.push(`[py-err] ${b.toString().trim()}`));
      closers.push(
        () =>
          new Promise<void>((res) => {
            worker.once('exit', () => res());
            worker.kill('SIGTERM');
            setTimeout(() => {
              worker.kill('SIGKILL');
              res();
            }, 3000);
          }),
      );
      const first = engines[0] as (typeof engines)[number];
      await waitFor(
        `python worker to register the 'py-echo' group\n${workerLog.join('\n')}`,
        async () => (await first.transport.listWorkerGroups()).includes('py-echo'),
        20_000,
      );
      const ids = Array.from({ length: 6 }, (_, i) => `rr-${i}`);
      for (const [i, id] of ids.entries()) {
        await (engines[i % 2] as (typeof engines)[number]).engine.start('py-seq', {}, id);
      }
      await waitFor(
        `runs to complete\n${workerLog.join('\n')}`,
        async () =>
          (await Promise.all(ids.map((id) => store.getRun(id)))).every(
            (r) => r?.status === 'completed',
          ),
        30_000,
      );
      for (const id of ids) expect((await store.getRun(id))?.output).toBe(4);
      const routes =
        spawnSync(PYTHON as string, ['-c', 'import durable_worker.result_publisher']).status === 0;
      // Routed by the Python worker: no body replayed on the other engine.
      if (routes) expect(entries, workerLog.join('\n')).toBe(ids.length);
      else expect(entries).toBeGreaterThanOrEqual(ids.length);
    },
    60_000,
  );
});

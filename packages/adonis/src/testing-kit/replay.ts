import {
  InMemoryStateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '../index.js';

export interface RunHistory {
  run: WorkflowRun;
  checkpoints: StepCheckpoint[];
}

/**
 * Capture a run's replayable history from a live engine (or anything with its read API) — the
 * fixture half of the {@link assertReplayable} loop. Pair with `node ace durable:export <runId>`
 * to pull one from a running app, commit the JSON, and assert it in CI via {@link parseRunHistory}.
 */
export async function captureHistory(
  source: Pick<WorkflowEngine, 'getRun' | 'listCheckpoints'>,
  runId: string,
): Promise<RunHistory | null> {
  const run = await source.getRun(runId);
  if (!run) return null;
  return { run, checkpoints: await source.listCheckpoints(runId) };
}

/**
 * Parse a committed history fixture (the JSON `durable:export` writes) back into a {@link
 * RunHistory}, reviving the Date fields JSON flattened to ISO strings — so
 * `assertReplayable(register, parseRunHistory(readFileSync('fixture.json', 'utf8')))` just works.
 */
export function parseRunHistory(json: string): RunHistory {
  const raw = JSON.parse(json) as { run: WorkflowRun; checkpoints: StepCheckpoint[] };
  const date = (v: unknown): Date => new Date(v as string | number | Date);
  const run: WorkflowRun = {
    ...raw.run,
    createdAt: date(raw.run.createdAt),
    updatedAt: date(raw.run.updatedAt),
  };
  const checkpoints = raw.checkpoints.map((cp) => ({
    ...cp,
    enqueuedAt: date(cp.enqueuedAt),
    startedAt: date(cp.startedAt),
    finishedAt: date(cp.finishedAt),
    ...(cp.lastHeartbeatAt != null ? { lastHeartbeatAt: date(cp.lastHeartbeatAt) } : {}),
  }));
  return { run, checkpoints };
}

/**
 * Replay a recorded run's history against the CURRENT workflow code and throw if they diverged.
 *
 * Capture a real (ideally in-flight or representative) run from production —
 * `{ run: await store.getRun(id), checkpoints: await store.listCheckpoints(id) }` — commit it as a
 * fixture, and assert here in CI. If a code change renamed/reordered/removed a step at a position the
 * history already recorded, the engine raises a `NonDeterminismError` on replay and this rethrows it,
 * catching the break *before* it reaches an in-flight run on deploy (the moment you'd otherwise
 * silently replay the wrong checkpoint into the wrong step). Register the workflow exactly as the app
 * does:
 *
 * ```ts
 * await assertReplayable((engine) => engine.register('pipeline', '1', pipeline.run), fixture);
 * ```
 */
export async function assertReplayable(
  register: (engine: WorkflowEngine) => void,
  history: RunHistory,
): Promise<void> {
  const store = new InMemoryStateStore();
  // Seed as a suspended run with no lock so resume() replays the body against the recorded
  // checkpoints — no transport is wired, so nothing new is dispatched.
  await store.createRun({
    ...history.run,
    status: 'suspended',
    lockedBy: undefined,
    lockedUntil: undefined,
  });
  for (const cp of history.checkpoints) await store.saveCheckpoint(cp);

  const engine = new WorkflowEngine({ store });
  register(engine);
  const result = await engine.resume(history.run.id);
  if (result.status === 'failed' && result.error?.message?.startsWith('non-determinism')) {
    const err = new Error(result.error.message);
    err.name = 'NonDeterminismError';
    throw err;
  }
}

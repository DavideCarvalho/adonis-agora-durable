import type { StepEvent, StepLogger, SubProcessHandle } from './interfaces.js';

/** Attach the elapsed `durationMs` (from `start`) to `data`, unless the caller already set one. */
function withDuration(start: number, now: () => number, data?: unknown): Record<string, unknown> {
  if (data && typeof data === 'object' && 'durationMs' in data) {
    return data as Record<string, unknown>;
  }
  const base = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { ...base, durationMs: now() - start };
}

/**
 * A {@link StepLogger} that appends to `events`, stamping each line with `now()`. Shared by the
 * local-step path (`ctx.step`) and the remote-worker path (`runStepHandler`) so a step records
 * the same {@link StepEvent} shape wherever it runs — the TypeScript twin of the Python SDK's
 * `StepContext`.
 */
/** Min ms between heartbeat EMISSIONS (see {@link StepLogger.heartbeat}) — a per-item beat in a hot
 *  loop must not flood the transport; the freshest progress payload still wins on each emission. */
const HEARTBEAT_MIN_INTERVAL_MS = 5_000;

/** The signal of a step that runs where nothing can shut it down early: never aborted. */
const NEVER_ABORTED = new AbortController().signal;

export function createStepLogger(
  events: StepEvent[],
  now: () => number,
  emitBeat?: (progress?: unknown) => void,
  signal: AbortSignal = NEVER_ABORTED,
): StepLogger {
  // The sub-process a `subProcess(...)` body is currently inside; debug/info/warn/error emitted while
  // inside get tagged with its id, so the dashboard groups that log trail under the sub-process.
  let currentSub: { id: string } | undefined;
  const push = (level: StepEvent['level'], message: string, data?: unknown) =>
    events.push({
      at: now(),
      level,
      message,
      ...(currentSub ? { subId: currentSub.id } : {}),
      ...(data === undefined ? {} : { data }),
    });
  const subEvent: StepLogger['subEvent'] = (e) =>
    events.push({
      at: now(),
      level: e.status === 'failed' ? 'error' : e.status === 'skipped' ? 'warn' : 'info',
      message: e.message ?? e.phase ?? e.name,
      subId: e.id,
      name: e.name,
      ...(e.group === undefined ? {} : { group: e.group }),
      ...(e.phase === undefined ? {} : { phase: e.phase }),
      ...(e.status === undefined ? {} : { status: e.status }),
      ...(e.data === undefined ? {} : { data: e.data }),
    });
  const subProcess: StepLogger['subProcess'] = async (name, body, opts) => {
    const id = opts?.id ?? globalThis.crypto.randomUUID();
    const group = opts?.group;
    const start = now();
    const prevSub = currentSub;
    currentSub = { id };
    let terminal = false;
    const emit = (status: 'ok' | 'failed' | 'skipped', message?: string, data?: unknown) => {
      if (terminal) return;
      terminal = true;
      subEvent({ id, name, group, status, message, data: withDuration(start, now, data) });
    };
    const handle: SubProcessHandle = {
      phase: (phase, data) => {
        if (!terminal) subEvent({ id, name, group, phase, data });
        return handle;
      },
      skip: (reason, data) => emit('skipped', reason, data),
      fail: (reason, data) => emit('failed', reason, data),
    };
    try {
      const result = await body(handle);
      emit('ok'); // no-op if the body already called skip()/fail()
      return result;
    } catch (err) {
      emit('failed', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      currentSub = prevSub;
    }
  };
  // Throttle EMISSION, not intent: a beat inside the window is dropped (the next allowed one carries
  // the then-freshest progress). `-Infinity` lets the first call emit immediately.
  let lastBeatAt = Number.NEGATIVE_INFINITY;
  const heartbeat = (progress?: unknown): void => {
    if (!emitBeat) return;
    const at = now();
    if (at - lastBeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastBeatAt = at;
    emitBeat(progress);
  };

  return {
    signal,
    debug: (m, d) => push('debug', m, d),
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
    error: (m, d) => push('error', m, d),
    heartbeat,
    sub: (name, status, message, data) =>
      events.push({
        at: now(),
        level: status === 'failed' ? 'error' : status === 'skipped' ? 'warn' : 'info',
        message: message ?? name,
        name,
        status,
        ...(data === undefined ? {} : { data }),
      }),
    subEvent,
    subProcess,
  };
}

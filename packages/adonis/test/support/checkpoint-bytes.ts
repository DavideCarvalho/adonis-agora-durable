import type { Database } from '@adonisjs/lucid/database';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StateStore, StepResult, Transport } from '../../src/interfaces.js';

/** Helpers for the specs that measure what a step's checkpoint costs the store to write and read. */

export const STEP = 'llm.complete';
/** A 100 KB prompt, the shape of a long conversation's LLM step input. */
export const PROMPT = `prompt:${'x'.repeat(100_000)}`;

export class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

export const ok = (task: RemoteTask, output: unknown = { text: 'hi' }): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output,
});

export async function until(check: () => Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** The characters of every string in `value`: what a statement sent or a response carried. */
function textSize(value: unknown, seen = new Set<unknown>()): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (Buffer.isBuffer(value)) return value.length;
  let size = 0;
  for (const v of Object.values(value)) size += textSize(v, seen);
  return size;
}

/** Captures what `db` sends (statements and their bindings) and what it reads back. */
export function capture(db: Database) {
  const sent: Array<{ sql: string; bindings: unknown[] }> = [];
  let read = 0;
  const clients = new Set([db.connection().getWriteClient(), db.connection().getReadClient()]);
  const onQuery = (q: { sql: string; bindings?: unknown[] }) =>
    sent.push({ sql: q.sql, bindings: q.bindings ?? [] });
  const onResponse = (response: unknown) => {
    read += textSize(response);
  };
  for (const client of clients) {
    client.on('query', onQuery);
    client.on('query-response', onResponse);
  }
  return {
    reset() {
      sent.length = 0;
      read = 0;
    },
    /** The statements that wrote a checkpoint row. */
    checkpointWrites: () =>
      sent.filter(
        (q) => /^\s*(insert|update)/i.test(q.sql) && /durable_step_checkpoints/.test(q.sql),
      ),
    bytesSent: (qs: Array<{ bindings: unknown[] }>) =>
      qs.reduce((n, q) => n + textSize(q.bindings), 0),
    bytesRead: () => read,
    stop() {
      for (const client of clients) {
        client.off('query', onQuery);
        client.off('query-response', onResponse);
      }
    },
  };
}

export function engineOn(
  store: StateStore,
  opts: { clock?: () => number; redispatchMs?: number } = {},
) {
  const transport = new HeldTransport();
  const engine = new WorkflowEngine({
    store,
    transports: [{ id: 't', transport }],
    reconcileMs: 0,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.redispatchMs ? { remoteRedispatchMs: opts.redispatchMs } : {}),
  });
  return { engine, transport };
}

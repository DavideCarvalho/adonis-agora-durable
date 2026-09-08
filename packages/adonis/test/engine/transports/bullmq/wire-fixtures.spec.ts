import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  EngineEvent,
  Heartbeat,
  RemoteTask,
  RunReply,
  RunRequest,
  RunResult,
  StartRunMessage,
  StepResult,
  TenantEvent,
  WorkflowTask,
} from '../../../../src/interfaces.js';

/**
 * Golden wire fixtures — the byte-canonical JSON each DTO crosses the BullMQ queue as (spec §6.3,
 * Appendix B). Every DTO rides as PLAIN JSON with NO envelope (the DTO is the job's `data`), so the
 * contract is: constructing the DTO and `JSON.stringify`ing it yields EXACTLY the fixture bytes, and
 * the fixture parses back to the DTO. A Python/NestJS SDK asserts the same fixtures — this is what
 * keeps polyglot interop from rotting.
 */
const fixture = (name: string): { text: string; value: unknown } => {
  const path = fileURLToPath(new URL(`../../../fixtures/wire/${name}`, import.meta.url));
  const text = readFileSync(path, 'utf8').trim();
  return { text, value: JSON.parse(text) };
};

/** The canonical compact bytes of a fixture (order-preserving), for a byte-exact stringify assertion. */
const canonical = (f: { value: unknown }): string => JSON.stringify(f.value);

describe('bullmq wire fixtures (byte-compat with aviary)', () => {
  it('task.step — a RemoteTask serializes to and parses from the golden bytes', () => {
    const f = fixture('task.step.json');
    const task: RemoteTask = {
      runId: 'run-abc',
      seq: 3,
      name: 'payments.charge-card',
      stepId: 'run-abc:3',
      group: 'payments.charge-card',
      input: { amount: 1200, currency: 'USD' },
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      context: { tenant: 'acme', userRef: 'user-42' },
      transport: 'primary',
      priority: 5,
      attempt: 1,
    };
    expect(JSON.stringify(task)).toBe(canonical(f)); // byte-exact
    expect(task).toEqual(f.value); // semantic
  });

  it('task.workflow — a WorkflowTask serializes to and parses from the golden bytes', () => {
    const f = fixture('task.workflow.json');
    const task: WorkflowTask = {
      taskId: 'run-xyz#2',
      runId: 'run-xyz',
      workflow: 'checkout',
      workflowVersion: '1.0.0',
      input: { cartId: 'cart-9' },
      history: [{ seq: 0, kind: 'step', name: 'inventory.reserve', output: { reserved: true } }],
      pendingSignals: [{ seq: 1, signal: 'payment.settled', payload: { amount: 1200 } }],
      group: 'checkout',
      transport: 'primary',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      priority: 5,
      attempt: 1,
    };
    expect(JSON.stringify(task)).toBe(canonical(f));
    expect(task).toEqual(f.value);
  });

  it('result — a completed StepResult serializes to and parses from the golden bytes', () => {
    const f = fixture('result.json');
    const result: StepResult = {
      runId: 'run-abc',
      seq: 3,
      stepId: 'run-abc:3',
      status: 'completed',
      output: { chargeId: 'ch_123', amount: 1200 },
      startedAt: 1752710400000,
      events: [{ at: 1752710400500, level: 'info', message: 'charged card' }],
    };
    expect(JSON.stringify(result)).toBe(canonical(f));
    expect(result).toEqual(f.value);
  });

  it('result — carries NO `name` field (correlation is purely runId/seq/stepId)', () => {
    const f = fixture('result.json');
    expect(Object.keys(f.value as object)).not.toContain('name');
  });

  it('heartbeat — a Heartbeat serializes to and parses from the golden bytes', () => {
    const f = fixture('heartbeat.json');
    const beat: Heartbeat = {
      runId: 'run-abc',
      seq: 3,
      stepId: 'run-abc:3',
      group: 'payments.charge-card',
    };
    expect(JSON.stringify(beat)).toBe(canonical(f));
    expect(beat).toEqual(f.value);
  });

  describe('serialization rules (§6.3) proven by construction', () => {
    it('a RemoteTask without a priority omits the `priority` key entirely', () => {
      const task: RemoteTask = {
        runId: 'r',
        seq: 1,
        name: 'n',
        stepId: 'r:1',
        group: 'n',
        input: null,
        attempt: 0,
      };
      expect(JSON.stringify(task)).not.toContain('priority');
    });

    it('a failed StepResult carries the StepError shape {message,code?,retryable?}, omitting absent optionals', () => {
      const failed: StepResult = {
        runId: 'r',
        seq: 1,
        stepId: 'r:1',
        status: 'failed',
        error: { message: 'card declined', code: 'declined', retryable: false },
      };
      // no `stack` when absent, no `name`, no `output` when absent
      expect(JSON.stringify(failed)).toBe(
        '{"runId":"r","seq":1,"stepId":"r:1","status":"failed","error":{"message":"card declined","code":"declined","retryable":false}}',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // P4 — store-less read/control/start DTOs (spec §8, Appendix A/B)
  // ---------------------------------------------------------------------------
  describe('P4 store-less protocol DTOs', () => {
    it('start-run — a StartRunMessage serializes to and parses from the golden bytes', () => {
      const f = fixture('start-run.json');
      const msg: StartRunMessage = {
        tenant: 'acme',
        workflow: 'checkout',
        input: { cartId: 'cart-9' },
        runId: 'run-checkout-1',
        tags: ['priority', 'vip'],
        searchAttributes: { amount: 1200, tier: 'pro' },
      };
      expect(JSON.stringify(msg)).toBe(canonical(f)); // byte-exact
      expect(msg).toEqual(f.value); // semantic
    });

    it('run-request — a RunRequest (listRuns) serializes to and parses from the golden bytes', () => {
      const f = fixture('run-request.json');
      const req: RunRequest = {
        requestId: 'req-1',
        tenant: 'acme',
        body: { kind: 'listRuns', query: { workflow: 'checkout', status: 'running', size: 20 } },
      };
      expect(JSON.stringify(req)).toBe(canonical(f));
      expect(req).toEqual(f.value);
    });

    it('run-reply.ok — a success RunReply (RunResult data) serializes to and parses from the golden bytes', () => {
      const f = fixture('run-reply.ok.json');
      const data: RunResult = {
        runId: 'run-checkout-1',
        status: 'completed',
        output: { orderId: 'order-42' },
      };
      const reply: RunReply = { requestId: 'run-checkout-1', result: { ok: true, data } };
      expect(JSON.stringify(reply)).toBe(canonical(f));
      expect(reply).toEqual(f.value);
    });

    it('run-reply.err — a failure RunReply carries {message, code}, no data', () => {
      const f = fixture('run-reply.err.json');
      const reply: RunReply = {
        requestId: 'req-1',
        result: {
          ok: false,
          error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
        },
      };
      expect(JSON.stringify(reply)).toBe(canonical(f));
      expect(reply).toEqual(f.value);
      expect(Object.keys((f.value as { result: object }).result)).not.toContain('data');
    });

    it('tenant-event — a TenantEvent serializes nested EngineEvent dates as ISO strings (§6.3)', () => {
      const f = fixture('tenant-event.json');
      const event: EngineEvent = {
        type: 'run.completed',
        runId: 'run-checkout-1',
        workflow: 'checkout',
        namespace: 'acme',
        output: { orderId: 'order-42' },
        durationMs: 1234,
        at: new Date('2025-07-17T00:00:00.000Z'),
      };
      const evt: TenantEvent = { tenant: 'acme', event };
      // Byte-exact: the `Date` serializes to its ISO string (Date.toJSON) — the §6.3 rule for dates
      // nested in an EngineEvent carried by a TenantEvent — matching the golden bytes exactly.
      expect(JSON.stringify(evt)).toBe(canonical(f));
      // And the fixture's `at` is that ISO string (not an epoch-ms number, unlike the task/result DTOs).
      expect((f.value as { event: { at: unknown } }).event.at).toBe('2025-07-17T00:00:00.000Z');
    });
  });
});

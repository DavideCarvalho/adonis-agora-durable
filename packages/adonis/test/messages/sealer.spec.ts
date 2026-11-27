import { describe, expect, it, vi } from 'vitest';
import type {
  Heartbeat,
  RemoteTask,
  RunReply,
  RunRequest,
  StartRunMessage,
  StepResult,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../src/interfaces.js';
import { sealerOf } from '../../src/messages/resolve.js';
import {
  createMessageSealer,
  isSealedMessage,
  type MessageCipher,
  type MessageKind,
  MessageRejectedError,
  type MessageSealer,
} from '../../src/messages/sealer.js';

const APP_KEY = 'a-test-app-key-that-is-long-enough';
const OTHER_KEY = 'another-app-key-that-is-long-enough';

const task: RemoteTask = {
  runId: 'run-1',
  seq: 3,
  stepId: 'run-1:3',
  name: 'payments.charge',
  group: 'payments.charge@acme',
  input: { card: '4242 4242 4242 4242', amount: 1999 },
  context: { userRef: 'user-7' },
  attempt: 1,
  traceparent: '00-abc-def-01',
};

/** One message of every kind, each carrying a secret the broker must not see. */
const SAMPLES: Array<[MessageKind, Record<string, unknown>, string]> = [
  ['task', task as unknown as Record<string, unknown>, '4242 4242 4242 4242'],
  [
    'workflowTask',
    {
      taskId: 't-1',
      runId: 'run-1',
      workflow: 'checkout',
      workflowVersion: '1',
      input: { secret: 'wf-input-secret' },
      history: [{ seq: 0, kind: 'step', output: 'history-secret' }],
      pendingSignals: [{ seq: 1, signal: 'go', payload: 'signal-secret' }],
      group: 'checkout',
      attempt: 1,
    } satisfies WorkflowTask,
    'history-secret',
  ],
  [
    'result',
    {
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      status: 'completed',
      output: { receipt: 'output-secret' },
      startedAt: 1,
    } satisfies StepResult,
    'output-secret',
  ],
  [
    'heartbeat',
    {
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      group: 'g',
      progress: { note: 'progress-secret' },
    } satisfies Heartbeat,
    'progress-secret',
  ],
  [
    'decision',
    {
      taskId: 't-1',
      runId: 'run-1',
      status: 'continue',
      commands: [{ kind: 'startChild', seq: 2, workflow: 'child', input: 'child-input-secret' }],
    } satisfies WorkflowDecision,
    'child-input-secret',
  ],
  [
    'stepEvent',
    {
      runId: 'run-1',
      seq: 4,
      name: 'local',
      phase: 'completed',
      startedAt: 1,
      output: 'step-event-secret',
    } satisfies WorkflowStepEvent,
    'step-event-secret',
  ],
  [
    'startRun',
    {
      tenant: 'tenant-token-secret',
      workflow: 'checkout',
      input: 'start-input-secret',
      runId: 'r',
    } satisfies StartRunMessage,
    'tenant-token-secret',
  ],
  [
    'runRequest',
    {
      requestId: 'req-1',
      tenant: 'tenant-token-secret',
      body: { kind: 'signal', runId: 'run-1', signal: 'go', payload: 'signal-payload-secret' },
    } satisfies RunRequest,
    'signal-payload-secret',
  ],
  [
    'runReply',
    { requestId: 'req-1', result: { ok: true, data: 'reply-secret' } } satisfies RunReply,
    'reply-secret',
  ],
  [
    'tenantEvent',
    {
      tenant: 'acme',
      event: { type: 'run.completed', output: 'event-secret' },
    } as unknown as Record<string, unknown>,
    'event-secret',
  ],
  [
    'control',
    { kind: 'event', from: 'i-1', event: { output: 'control-secret' } },
    'control-secret',
  ],
];

/** A broker round trip: JSON out, JSON in. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An in-memory stand-in for `@adonis-agora/crypto`: AES with one key, `agora:ct1:<key>:` ciphertexts. */
function fakeCipher(keyName = 'durable-messages'): MessageCipher & { calls: string[] } {
  const box = new Map<string, { plaintext: string; aad?: string | undefined }>();
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    async encrypt({ key, plaintext, aad }) {
      calls.push(`encrypt:${key}`);
      n += 1;
      const ciphertext = `agora:ct1:${keyName}:${n}`;
      box.set(ciphertext, { plaintext, aad });
      return { ciphertext };
    },
    async decrypt({ key, ciphertext, aad }) {
      calls.push(`decrypt:${key}`);
      const entry = box.get(ciphertext);
      if (!entry || entry.aad !== aad) throw new Error('unable to authenticate data');
      return { plaintext: entry.plaintext };
    },
  };
}

function sealers(): Array<[string, MessageSealer, MessageSealer]> {
  const cipher = fakeCipher();
  const crypto = () =>
    createMessageSealer({
      mode: 'crypto',
      source: {
        key: 'durable-messages',
        label: 'crypto (key durable-messages)',
        cipherFor: async () => cipher,
        sealPartition: () => '',
        accepts: (p) => p === '',
      },
    });
  return [
    [
      'app key',
      createMessageSealer({ mode: 'app-key', appKey: APP_KEY }),
      createMessageSealer({ mode: 'app-key', appKey: APP_KEY }),
    ],
    ['crypto', crypto(), crypto()],
  ];
}

describe('message sealing', () => {
  for (const [mode, sender, receiver] of sealers()) {
    describe(mode, () => {
      for (const [kind, msg, secret] of SAMPLES) {
        it(`seals a ${kind} message: nothing secret in clear, opened intact`, async () => {
          const sealed = wire(await sender.seal(kind, msg));
          expect(isSealedMessage(sealed)).toBe(true);
          expect(JSON.stringify(sealed)).not.toContain(secret);
          expect(await receiver.open(kind, sealed)).toEqual(wire(msg));
        });
      }

      it('rejects a tampered ciphertext', async () => {
        const sealed = wire(await sender.seal('task', task)) as unknown as Record<string, string>;
        const seal = sealed.sealed as string;
        const flipped = `${seal.slice(0, -2)}${seal.at(-2) === 'A' ? 'B' : 'A'}${seal.at(-1)}`;
        await expect(receiver.open('task', { ...sealed, sealed: flipped })).rejects.toMatchObject({
          reason: 'unauthenticated',
        });
      });

      it('rejects a ciphertext moved into another step, run or kind (replay into another slot)', async () => {
        const sealed = wire(await sender.seal('task', task)) as unknown as Record<string, unknown>;
        for (const moved of [
          { ...sealed, seq: 4, stepId: 'run-1:4' },
          { ...sealed, runId: 'run-2', stepId: 'run-2:3' },
          { ...sealed, name: 'payments.refund' },
        ]) {
          await expect(receiver.open('task', moved)).rejects.toBeInstanceOf(MessageRejectedError);
        }
        // A task's seal is not a result's.
        await expect(
          receiver.open('result', { ...sealed, status: 'completed' }),
        ).rejects.toBeInstanceOf(MessageRejectedError);
      });

      it('accepts plain messages by default and logs once per kind', async () => {
        const onPlain = vi.fn();
        const lenient =
          mode === 'app key'
            ? createMessageSealer({ mode: 'app-key', appKey: APP_KEY }, { onPlain })
            : receiver;
        expect(await lenient.open('task', wire(task))).toEqual(wire(task));
        if (mode === 'app key') {
          await lenient.open('task', wire(task));
          expect(onPlain).toHaveBeenCalledTimes(2);
          expect(onPlain).toHaveBeenCalledWith('task');
        }
      });
    });
  }

  it('refuses plain messages with acceptPlain: false', async () => {
    const report = vi.fn();
    const strict = createMessageSealer(
      { mode: 'app-key', appKey: APP_KEY },
      { acceptPlain: false, report },
    );
    await expect(strict.open('result', wire(SAMPLES[2]?.[1]))).rejects.toMatchObject({
      reason: 'unsealed',
      code: 'E_DURABLE_MESSAGE_REJECTED',
    });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('rejects a message sealed with another APP_KEY', async () => {
    const theirs = createMessageSealer({ mode: 'app-key', appKey: OTHER_KEY });
    const ours = createMessageSealer({ mode: 'app-key', appKey: APP_KEY });
    const sealed = wire(await theirs.seal('task', task));
    await expect(ours.open('task', sealed)).rejects.toMatchObject({ reason: 'unauthenticated' });
  });

  it('rejects a message sealed with another crypto key', async () => {
    const source = (cipher: MessageCipher) => ({
      key: 'durable-messages',
      label: 'crypto',
      cipherFor: async () => cipher,
      sealPartition: () => '',
      accepts: (p: string) => p === '',
    });
    const theirs = createMessageSealer({ mode: 'crypto', source: source(fakeCipher()) });
    const ours = createMessageSealer({ mode: 'crypto', source: source(fakeCipher()) });
    const sealed = wire(await theirs.seal('result', SAMPLES[2]?.[1] as object));
    await expect(ours.open('result', sealed)).rejects.toMatchObject({ reason: 'unauthenticated' });
  });

  it('crypto mode seals one session key, not one call per message', async () => {
    const cipher = fakeCipher();
    const sealer = createMessageSealer({
      mode: 'crypto',
      source: {
        key: 'durable-messages',
        label: 'crypto',
        cipherFor: async () => cipher,
        sealPartition: () => '',
        accepts: (p) => p === '',
      },
    });
    for (let i = 0; i < 20; i++) await sealer.seal('heartbeat', { runId: 'r', seq: i, group: 'g' });
    expect(cipher.calls).toEqual(['encrypt:durable-messages']);
  });

  it('secret mode authenticates but keeps the message readable', async () => {
    const a = createMessageSealer({ mode: 'secret', secret: 'a-shared-secret-of-16+' });
    const b = createMessageSealer({ mode: 'secret', secret: 'a-shared-secret-of-16+' });
    const other = createMessageSealer({ mode: 'secret', secret: 'another-shared-secret!' });
    const sealed = wire(await a.seal('task', task));
    expect(JSON.stringify(sealed)).toContain('4242');
    expect(await b.open('task', sealed)).toEqual(wire(task));
    await expect(other.open('task', sealed)).rejects.toMatchObject({ reason: 'unauthenticated' });
    // Key order may change on the broker (Postgres jsonb): still authentic.
    const reordered = Object.fromEntries(Object.entries(sealed).reverse());
    expect(await b.open('task', reordered)).toEqual(wire(task));
    await expect(
      b.open('task', { ...sealed, input: { card: 'x', amount: 1 } }),
    ).rejects.toMatchObject({ reason: 'unauthenticated' });
  });

  it('a top-level `__proto__` added on the broker breaks the seal (secret mode)', async () => {
    const secret = createMessageSealer({ mode: 'secret', secret: 'a-shared-secret-of-16+' });
    const sealed = JSON.stringify(await secret.seal('task', task));
    const tampered = JSON.parse(`{"__proto__":{"admin":true},${sealed.slice(1)}`) as object;
    await expect(secret.open('task', tampered)).rejects.toMatchObject({
      reason: 'unauthenticated',
    });
    // And a `__proto__` field of the message itself is sealed and comes back as an own field.
    const appKey = createMessageSealer({ mode: 'app-key', appKey: APP_KEY });
    const withProto = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(task).slice(1)}`) as Record<
      string,
      unknown
    >;
    const opened = await appKey.open<Record<string, unknown>>(
      'task',
      wire(await appKey.seal('task', withProto)),
    );
    expect(Object.hasOwn(opened, '__proto__')).toBe(true);
  });

  it('reports a crypto server that cannot be reached as crypto-unavailable', async () => {
    const sender = createMessageSealer({
      mode: 'crypto',
      source: {
        key: 'durable-messages',
        label: 'crypto',
        cipherFor: async () => fakeCipher(),
        sealPartition: () => '',
        accepts: (p) => p === '',
      },
    });
    const down = createMessageSealer({
      mode: 'crypto',
      source: {
        key: 'durable-messages',
        label: 'crypto',
        cipherFor: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3333');
        },
        sealPartition: () => '',
        accepts: (p) => p === '',
      },
    });
    const sealed = wire(await sender.seal('task', task));
    await expect(down.open('task', sealed)).rejects.toMatchObject({ reason: 'crypto-unavailable' });
  });

  it('a plain transport opens sealed messages only with a key to open them', async () => {
    const appKey = createMessageSealer({ mode: 'app-key', appKey: APP_KEY });
    const sealed = wire(await appKey.seal('task', task));
    const withKey = createMessageSealer({ mode: 'plain', fallback: appKey });
    expect(await withKey.open('task', sealed)).toEqual(wire(task));
    const report = vi.fn();
    const without = createMessageSealer({ mode: 'plain' }, { report });
    await expect(without.open('task', sealed)).rejects.toMatchObject({ reason: 'unopenable' });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('`insecure: true` sends plain but still opens what upgraded processes seal (step 1 of a rollout)', async () => {
    const stepOne = sealerOf({ insecure: true, appKey: APP_KEY }, 't');
    const upgraded = sealerOf({ appKey: APP_KEY }, 't');
    expect(await stepOne.seal('task', task)).toBe(task);
    expect(await stepOne.open('task', wire(await upgraded.seal('task', task)))).toEqual(wire(task));
  });

  it('a clear field added on the broker cannot smuggle data into an opened message', async () => {
    const sealer = createMessageSealer({ mode: 'app-key', appKey: APP_KEY });
    const sealed = wire(
      await sealer.seal('result', { runId: 'r', seq: 1, stepId: 'r:1', status: 'completed' }),
    );
    const opened = await sealer.open<Record<string, unknown>>('result', {
      ...sealed,
      output: 'injected',
    });
    expect(opened.output).toBeUndefined();
  });

  it('a transport built directly seals with process.env.APP_KEY, else stays plain', async () => {
    const previous = process.env.APP_KEY;
    try {
      delete process.env.APP_KEY;
      expect(sealerOf(undefined, 't').mode).toBe('plain');
      process.env.APP_KEY = APP_KEY;
      const sealer = sealerOf(undefined, 't');
      expect(sealer.mode).toBe('app-key');
      expect(sealerOf({ insecure: true }, 't').mode).toBe('plain');
      expect(sealerOf({ crypto: false }, 't').mode).toBe('plain');
      expect(sealerOf({ secret: 'a-shared-secret-of-16+' }, 't').mode).toBe('secret');
      expect(() => sealerOf({ secret: 'a-shared-secret-of-16+', insecure: true }, 't')).toThrow(
        /one of `secret`, `crypto` or `insecure`/,
      );
    } finally {
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  });
});

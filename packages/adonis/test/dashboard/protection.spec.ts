import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from '../../src/codec-state-store.js';
import { RedisControlPlane } from '../../src/control-plane-redis/redis-control-plane.js';
import { answerConsoleCommands, FederatedApp } from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  consoleProtection,
  type DashboardEngine,
  type Deps,
  getRun,
  topology,
} from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { Transport } from '../../src/interfaces.js';
import { sealerOf } from '../../src/messages/resolve.js';
import { createMessageSealer, type MessageSealer } from '../../src/messages/sealer.js';
import {
  AT_REST_COVERAGE,
  sanitizeAppProtection,
  sealerProtection,
  storeProtectionOf,
} from '../../src/protection.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { consoleBus } from '../support/console-bus.js';

const SECRET = 'console-badge-secret-0123456789abcdef';
const APP_KEY = 'app-key-for-badges-0123456789abcdef';

/** A broker-like transport: in-memory, carrying a real sealer like the broker transports do. */
function sealedTransport(sealer: MessageSealer): Transport {
  const transport = new InMemoryTransport();
  Object.defineProperty(transport, 'messageSealer', { get: () => sealer });
  return transport;
}

const cryptoSealer = () =>
  createMessageSealer(
    {
      mode: 'crypto',
      source: {
        key: 'kid-secret-name',
        label: 'crypto (key kid-secret-name)',
        cipherFor: async () => {
          throw new Error('not used');
        },
        sealPartition: () => '',
        accepts: () => true,
      },
    },
    { acceptPlain: false },
  );

const tenantKeySealer = () =>
  createMessageSealer(
    {
      mode: 'tenant-key',
      source: {
        label: 'tenant keys',
        sealKey: async () => {
          throw new Error('not used');
        },
        openKey: async () => undefined,
        bootstrap: () => false,
      },
    },
    { acceptPlain: false },
  );

const reversing: PayloadCodec = {
  encode: (v) => (v === undefined ? v : { enc: JSON.stringify(v) }),
  decode: (v) =>
    v !== null && typeof v === 'object' && 'enc' in (v as object)
      ? JSON.parse((v as { enc: string }).enc)
      : v,
};

describe('engine.protection()', () => {
  it('reports each pooled transport and the control plane from their runtime sealers', () => {
    const plane = new RedisControlPlane({
      // Never touched beyond subscribing: every call is a no-op.
      connection: new Proxy({}, { get: () => () => undefined }) as never,
      messages: { secret: SECRET, acceptPlain: false },
    });
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transports: [
        {
          id: 'bullmq',
          transport: sealedTransport(sealerOf({ appKey: APP_KEY, seal: true }, 'bullmq')),
        },
        { id: 'db', transport: sealedTransport(sealerOf({ secret: SECRET }, 'db')) },
        { id: 'queue', transport: sealedTransport(cryptoSealer()) },
        { id: 'tenant', transport: sealedTransport(tenantKeySealer()) },
        { id: 'legacy', transport: sealedTransport(sealerOf({ appKey: APP_KEY }, 'legacy')) },
        // In-process: no sealer, not listed.
        { id: 'memory', transport: new InMemoryTransport() },
      ],
      controlPlane: plane,
    });
    const protection = engine.protection();
    expect(protection.messages).toEqual([
      { transport: 'bullmq', mode: 'app-key', acceptPlain: true },
      { transport: 'db', mode: 'secret', acceptPlain: true },
      { transport: 'queue', mode: 'crypto', acceptPlain: false },
      { transport: 'tenant', mode: 'tenant-key', acceptPlain: false },
      // A key is configured but sealing is not on: it sends plain.
      { transport: 'legacy', mode: 'plain', acceptPlain: true },
      { transport: 'control plane', mode: 'secret', acceptPlain: false },
    ]);
    expect(protection.store).toEqual({ codec: false, coverage: null });

    const json = JSON.stringify(protection);
    for (const material of [SECRET, APP_KEY, 'kid-secret-name', 'dm1.']) {
      expect(json).not.toContain(material);
    }
  });

  it('detects a CodecStateStore and its coverage, and a store marked as encoding', () => {
    const inner = new InMemoryStateStore();
    expect(storeProtectionOf(new CodecStateStore(inner, reversing))).toEqual({
      codec: true,
      coverage: 'payloads',
    });
    expect(
      storeProtectionOf(new CodecStateStore(inner, reversing, { coverage: 'extended' })),
    ).toEqual({ codec: true, coverage: 'extended' });
    const scoped = new CodecStateStore(inner, reversing, { coverage: 'extended' }).withScope?.({
      namespace: 'a',
    });
    if (scoped) expect(storeProtectionOf(scoped).coverage).toBe('extended');
    expect(storeProtectionOf({ [AT_REST_COVERAGE]: 'payloads' })).toEqual({
      codec: true,
      coverage: 'payloads',
    });
    expect(storeProtectionOf(inner)).toEqual({ codec: false, coverage: null });
    expect(
      new WorkflowEngine({ store: new CodecStateStore(inner, reversing) }).protection(),
    ).toEqual({ messages: [], store: { codec: true, coverage: 'payloads' } });
  });

  it('ignores an owner without a known sealer', () => {
    expect(sealerProtection('x', {})).toBeUndefined();
    expect(sealerProtection('x', { messageSealer: { mode: 'rot13' } })).toBeUndefined();
    expect(sealerProtection('x', null)).toBeUndefined();
  });
});

describe('consoleProtection / topology', () => {
  it('adds the redact flags and keeps names and modes only', async () => {
    const engine = {
      protection: () => ({
        messages: [
          { transport: 'bullmq', mode: 'tenant-key', acceptPlain: false, key: SECRET },
          { transport: 'evil', mode: 'rot13', acceptPlain: true },
        ],
        store: { codec: true, coverage: 'extended', codec_key: SECRET },
        token: SECRET,
      }),
    } as unknown as DashboardEngine;
    const protection = await consoleProtection(engine, { run: (r) => r });
    expect(protection).toEqual({
      messages: [{ transport: 'bullmq', mode: 'tenant-key', acceptPlain: false }],
      store: { codec: true, coverage: 'extended' },
      redact: { run: true, checkpoint: false },
    });
    const body = topology('standalone', undefined, protection).body;
    expect(body).toEqual({ role: 'standalone', protection });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // Unchanged without protection.
    expect(topology('tenant', 'acme').body).toEqual({ role: 'tenant', tenant: 'acme' });
  });

  it('is undefined when the app cannot tell, fails, or does not answer in time', async () => {
    expect(await consoleProtection({}, undefined)).toBeUndefined();
    expect(
      await consoleProtection(
        {
          protection: () => {
            throw new Error('nope');
          },
        },
        undefined,
      ),
    ).toBeUndefined();
    expect(
      await consoleProtection(
        { protection: () => new Promise(() => undefined) as never },
        undefined,
        20,
      ),
    ).toBeUndefined();
    expect(sanitizeAppProtection({ messages: 'x' })).toBeUndefined();
  });
});

describe('run detail markers', () => {
  async function detailOf(deps: Partial<Deps>, store = new InMemoryStateStore()) {
    const raw = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    raw.register('wf', '1', async (ctx) => {
      await ctx.localStep('charge', async () => ({ card: '4242' }));
      return { ok: true };
    });
    await raw.start('wf', { card: '4242' }, 'r1');
    await new Promise((r) => setTimeout(r, 30));
    const res = await getRun(
      { engine: storeDashboardEngine(raw), ...deps },
      { params: { id: 'r1' }, query: {} },
    );
    return res.body as {
      run: Record<string, unknown>;
      timeline: Array<Record<string, unknown>>;
      encryptedAtRest?: { run: string[]; step: string[] };
    };
  }

  it('names the fields the store encrypts at rest, per coverage', async () => {
    expect((await detailOf({})).encryptedAtRest).toBeUndefined();
    expect(
      (await detailOf({ atRest: { codec: true, coverage: 'payloads' } })).encryptedAtRest,
    ).toEqual({ run: ['input', 'output'], step: ['input', 'output'] });
    const extended = await detailOf({ atRest: { codec: true, coverage: 'extended' } });
    expect(extended.encryptedAtRest).toEqual({
      run: ['input', 'output', 'error'],
      step: ['input', 'output', 'error', 'events'],
    });
    expect((await detailOf({ atRest: { codec: false, coverage: null } })).encryptedAtRest).toBe(
      undefined,
    );
  });

  it('names the fields a redact hook hid, without their values', async () => {
    const detail = await detailOf({
      redact: {
        run: (run) => {
          const { output: _output, ...rest } = run;
          return { ...rest, input: '[redacted]' };
        },
        // Edits in place: still detected.
        checkpoint: (cp) => {
          cp.output = '[hidden]';
          return cp;
        },
      },
    });
    expect(detail.run.redactedFields).toEqual(['input', 'output']);
    expect(detail.timeline[0]?.redactedFields).toEqual(['output']);
    expect(JSON.stringify(detail.run.redactedFields)).not.toContain('4242');
    // No hook, no marker.
    const plain = await detailOf({});
    expect(plain.run.redactedFields).toBeUndefined();
    expect(plain.timeline[0]?.redactedFields).toBeUndefined();
  });
});

describe('federated console', () => {
  it("shows another app's protection, as that app reports it", async () => {
    const bus = consoleBus();
    const storeB = new CodecStateStore(new InMemoryStateStore(), reversing, {
      coverage: 'extended',
    });
    const engineB = new WorkflowEngine({
      store: storeB,
      transports: [{ id: 'bullmq', transport: sealedTransport(tenantKeySealer()) }],
      controlPlane: bus.plane(),
      instanceId: 'b',
    });
    answerConsoleCommands(bus.plane(), storeDashboardEngine(engineB), undefined, {
      actions: true,
    });
    const app = new FederatedApp({ id: 'b', store: storeB, controlPlane: bus.plane() });
    const protection = await consoleProtection(app.engine('ops'), undefined);
    expect(protection).toEqual({
      messages: [
        { transport: 'bullmq', mode: 'tenant-key', acceptPlain: false },
        // The bus plane has no sealer: not listed.
      ],
      store: { codec: true, coverage: 'extended' },
      redact: { run: false, checkpoint: false },
    });
    expect(app.storeProtection).toEqual({ codec: true, coverage: 'extended' });
  });

  it('an app too old to answer gets no protection (no badge)', async () => {
    const bus = consoleBus();
    const old = bus.plane();
    // An older app: it answers console commands, but not `protection`.
    const engine = storeDashboardEngine(
      new WorkflowEngine({ store: new InMemoryStateStore(), instanceId: 'old' }),
    );
    delete (engine as { protection?: unknown }).protection;
    answerConsoleCommands(old, engine, undefined, { actions: true });
    const app = new FederatedApp({
      id: 'old',
      store: new InMemoryStateStore(),
      controlPlane: bus.plane(),
    });
    expect(await consoleProtection(app.engine('ops'), undefined)).toBeUndefined();
    expect(app.storeProtection).toEqual({ codec: false, coverage: null });
  });
});

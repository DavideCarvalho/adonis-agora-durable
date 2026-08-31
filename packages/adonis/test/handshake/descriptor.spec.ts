import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROTOCOL_VERSION,
  descriptorHash,
  heartbeatStatus,
  isLegacyDescriptor,
  LEGACY_V1_CAPABILITIES,
  LEGACY_V1_PROTOCOL,
  normalizeDescriptor,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
} from '../../src/handshake/descriptor.js';

/** A fully-specified modern descriptor. */
function makeDescriptor(overrides: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    instanceId: 'ts-a-1',
    runtime: 'node',
    sdk: { name: '@adonis-agora/durable', version: '1.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: ['saga', 'signals'],
    workflows: ['CheckoutWorkflow'],
    steps: ['Billing.charge'],
    startedAt: 1000,
    ...overrides,
  };
}

describe('descriptorHash — stability + sensitivity', () => {
  it('is order-insensitive over the set-valued fields (same members, any order → same hash)', () => {
    const a = makeDescriptor({
      capabilities: ['saga', 'signals', 'priority'],
      workflows: ['A', 'B', 'C'],
      steps: ['x', 'y'],
    });
    const b = makeDescriptor({
      capabilities: ['priority', 'saga', 'signals'],
      workflows: ['C', 'A', 'B'],
      steps: ['y', 'x'],
    });
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });

  it('is insensitive to object key insertion order', () => {
    const a = makeDescriptor();
    // Rebuild with keys in a different insertion order.
    const b: WorkerDescriptor = {
      startedAt: a.startedAt,
      steps: a.steps,
      workflows: a.workflows,
      capabilities: a.capabilities,
      protocol: a.protocol,
      sdk: a.sdk,
      runtime: a.runtime,
      instanceId: a.instanceId,
    };
    expect(descriptorHash(b)).toBe(descriptorHash(a));
  });

  it('de-duplicates set members (a repeated capability does not change the hash)', () => {
    const base = makeDescriptor({ capabilities: ['saga', 'signals'] });
    const dup = makeDescriptor({ capabilities: ['saga', 'signals', 'saga'] });
    expect(descriptorHash(dup)).toBe(descriptorHash(base));
  });

  // --- Sensitivity: mutating ANY content-bearing field changes the hash (mutation proof). ---
  it('changes when a capability is added', () => {
    expect(
      descriptorHash(makeDescriptor({ capabilities: ['saga', 'signals', 'priority'] })),
    ).not.toBe(descriptorHash(makeDescriptor()));
  });

  it('changes when a workflow changes', () => {
    expect(descriptorHash(makeDescriptor({ workflows: ['Other'] }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when a step changes', () => {
    expect(descriptorHash(makeDescriptor({ steps: ['Billing.refund'] }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when startedAt changes (a restart triggers a re-read)', () => {
    expect(descriptorHash(makeDescriptor({ startedAt: 2000 }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when the protocol range changes', () => {
    expect(descriptorHash(makeDescriptor({ protocol: { version: 2, range: [1, 2] } }))).not.toBe(
      descriptorHash(makeDescriptor()),
    );
  });

  it('changes when partition/namespace change (present-vs-absent are distinct)', () => {
    const withPartition = descriptorHash(makeDescriptor({ partition: 'p1' }));
    const withoutPartition = descriptorHash(makeDescriptor());
    expect(withPartition).not.toBe(withoutPartition);
  });

  it('produces a 16-char lowercase hex string', () => {
    expect(descriptorHash(makeDescriptor())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalizeDescriptor — legacy-v1 backward-compat (design §7.7)', () => {
  it('defaults an absent protocol to the legacy v1 baseline', () => {
    const raw: RawWorkerDescriptor = { instanceId: 'legacy-1', runtime: 'python' };
    expect(normalizeDescriptor(raw).protocol).toEqual(LEGACY_V1_PROTOCOL);
  });

  it('defaults an absent capabilities field to the v1 baseline set', () => {
    const raw: RawWorkerDescriptor = { instanceId: 'legacy-1', runtime: 'python' };
    expect(normalizeDescriptor(raw).capabilities).toEqual([...LEGACY_V1_CAPABILITIES]);
  });

  it('PRESERVES an explicit empty capabilities array (modern SDK that advertises nothing)', () => {
    const raw: RawWorkerDescriptor = {
      instanceId: 'modern-1',
      runtime: 'node',
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
    };
    expect(normalizeDescriptor(raw).capabilities).toEqual([]);
  });

  it('defaults workflows/steps/sdk/startedAt on a bare descriptor', () => {
    const n = normalizeDescriptor({ instanceId: 'legacy-1', runtime: 'python' });
    expect(n.workflows).toEqual([]);
    expect(n.steps).toEqual([]);
    expect(n.sdk).toEqual({ name: 'unknown', version: '0' });
    expect(n.startedAt).toBe(0);
  });

  it('leaves a fully-specified descriptor untouched', () => {
    const d = makeDescriptor({ partition: 'p', namespace: 'n' });
    expect(normalizeDescriptor(d)).toEqual(d);
  });
});

describe('isLegacyDescriptor', () => {
  it('is true when protocol is absent', () => {
    expect(isLegacyDescriptor({ instanceId: 'x', runtime: 'node' })).toBe(true);
  });
  it('is false once protocol is present', () => {
    expect(isLegacyDescriptor(makeDescriptor())).toBe(false);
  });
});

describe('heartbeatStatus — two-tier advertisement (design §7.2)', () => {
  it('stamps the descriptor ETag and defaults status/ts', () => {
    const d = makeDescriptor();
    const hb = heartbeatStatus(d, { ts: 5 });
    expect(hb).toEqual({ ts: 5, status: 'up', descriptorHash: descriptorHash(d) });
  });

  it('carries an explicit lifecycle status', () => {
    const hb = heartbeatStatus(makeDescriptor(), { ts: 5, status: 'draining' });
    expect(hb.status).toBe('draining');
  });

  it('the ETag tracks descriptor changes (different descriptor → different hash on the beat)', () => {
    const a = heartbeatStatus(makeDescriptor(), { ts: 1 });
    const b = heartbeatStatus(makeDescriptor({ capabilities: ['saga'] }), { ts: 1 });
    expect(a.descriptorHash).not.toBe(b.descriptorHash);
  });
});

describe('constants', () => {
  it('exposes the current protocol version as v1', () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(1);
  });
});

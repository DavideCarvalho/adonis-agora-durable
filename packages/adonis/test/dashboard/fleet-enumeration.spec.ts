import { describe, expect, it } from 'vitest';
import {
  type CompatSource,
  compat,
  enumerateLiveFleet,
  type FleetGroup,
  type FleetTransport,
  mergeFleets,
} from '../../src/dashboard/compat.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';

function worker(partial: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'test', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...partial,
  };
}

/** A fake broker transport advertising a live descriptor keyspace, token → descriptors. */
function fleetTransport(byToken: Record<string, WorkerDescriptor[]>): FleetTransport {
  return {
    listWorkerGroups: async () => Object.keys(byToken),
    listWorkerDescriptors: async (token) => byToken[token] ?? [],
  };
}

describe('enumerateLiveFleet — LIVE green-fleet enumeration off the transport', () => {
  it('enumerates every token’s live workers (compatible AND incompatible)', async () => {
    const transport = fleetTransport({
      'billing.charge@acme': [
        worker({ instanceId: 'ok-1' }),
        worker({ instanceId: 'py-1', runtime: 'python', protocol: { version: 2, range: [2, 2] } }),
      ],
      'email.send@acme': [worker({ instanceId: 'ok-2' })],
    });
    const fleet = await enumerateLiveFleet(transport);
    const billing = fleet.find((g) => g.token === 'billing.charge@acme');
    expect(billing?.workers.map((w) => w.instanceId).sort()).toEqual(['ok-1', 'py-1']);
    expect(fleet.find((g) => g.token === 'email.send@acme')?.workers).toHaveLength(1);
  });

  it('degrades to [] when the transport has no fleet capability', async () => {
    expect(await enumerateLiveFleet(null)).toEqual([]);
    expect(await enumerateLiveFleet({})).toEqual([]);
    expect(await enumerateLiveFleet({ listWorkerGroups: async () => ['t'] })).toEqual([]);
  });

  it('drops a token whose workers are all legacy (no descriptor published)', async () => {
    // A live heartbeat token with an empty descriptor set contributes nothing (legacy = assume-compatible).
    const fleet = await enumerateLiveFleet(fleetTransport({ 'legacy@acme': [] }));
    expect(fleet).toEqual([]);
  });

  it('never throws — a scan failure degrades to whatever was read', async () => {
    const transport: FleetTransport = {
      listWorkerGroups: async () => ['boom@acme'],
      listWorkerDescriptors: async () => {
        throw new Error('redis down');
      },
    };
    await expect(enumerateLiveFleet(transport)).resolves.toEqual([]);
  });
});

describe('mergeFleets — union of captured + live snapshots, live wins per instance', () => {
  it('adds live-only workers and overrides a stale captured descriptor', () => {
    const captured: FleetGroup[] = [
      { token: 'billing@acme', workers: [worker({ instanceId: 'py-1', capabilities: ['stale'] })] },
    ];
    const live: FleetGroup[] = [
      {
        token: 'billing@acme',
        workers: [
          worker({ instanceId: 'py-1', capabilities: ['fresh'] }),
          worker({ instanceId: 'new-1' }),
        ],
      },
    ];
    const merged = mergeFleets(captured, live);
    const group = merged.find((g) => g.token === 'billing@acme');
    expect(group?.workers).toHaveLength(2);
    // Live (passed last) wins for the shared instance.
    expect(group?.workers.find((w) => w.instanceId === 'py-1')?.capabilities).toEqual(['fresh']);
    expect(group?.workers.some((w) => w.instanceId === 'new-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The mutation-facing proof: an INCOMPATIBLE live worker with NO prior blocked
// dispatch (so the diagnostics recorder never saw it) must still show red on the
// panel, purely from the live enumeration. Break enumeration → it disappears.
// ---------------------------------------------------------------------------

describe('compat panel over the LIVE fleet (no prior block)', () => {
  it('red-flags an incompatible live worker the diagnostics recorder never captured', async () => {
    // Diagnostics recorder is EMPTY (no run ever blocked); the worker is known only via live enumeration.
    const live = await enumerateLiveFleet(
      fleetTransport({
        'billing.charge@acme': [
          worker({
            instanceId: 'py-1',
            runtime: 'python',
            protocol: { version: 2, range: [2, 2] },
          }),
        ],
      }),
    );
    const src: CompatSource = {
      controlPlaneDescriptor: () =>
        worker({ instanceId: 'cp', protocol: { version: 1, range: [1, 1] } }),
      // What the provider builds: merge(diagnostics=[], live). The captured side is empty.
      fleet: () => mergeFleets([], live),
      blockedRuns: async () => [],
      diagnosticsFor: () => undefined,
    };

    const body = (await compat(src)).body as {
      groups: Array<{
        token: string;
        incompatible: boolean;
        pods: Array<{ instanceId: string; incompatible: boolean; reason?: string }>;
      }>;
      incompatibleCount: number;
    };

    const group = body.groups.find((g) => g.token === 'billing.charge@acme');
    expect(group?.incompatible).toBe(true);
    const pod = group?.pods.find((p) => p.instanceId === 'py-1');
    expect(pod?.incompatible).toBe(true);
    expect(pod?.reason).toContain('no common protocol major');
    expect(body.incompatibleCount).toBe(1);
  });
});

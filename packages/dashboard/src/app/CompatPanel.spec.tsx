// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompatPod, CompatReport } from '../client/durable-client';
import { CompatHealth, fleetOutcome, formatProtocolRange } from './CompatPanel';
import { TooltipProvider } from './ui/tooltip';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

function pod(overrides: Partial<CompatPod> = {}): CompatPod {
  return {
    instanceId: 'worker-1',
    protocol: 1,
    protocolRange: [1, 1],
    capabilities: ['step.remote'],
    outcome: 'compatible',
    negotiatedProtocol: 1,
    incompatible: false,
    missingOnRemote: [],
    missingOnLocal: [],
    ...overrides,
  };
}

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  return {
    controlPlane: {
      instanceId: 'control-plane',
      protocol: 1,
      protocolRange: [1, 1],
      capabilities: ['step.remote'],
    },
    groups: [],
    blocked: [],
    incompatibleCount: 0,
    blockedCount: 0,
    ...overrides,
  };
}

function renderPanel(compat: CompatReport, onOpenRun = vi.fn()) {
  render(
    <TooltipProvider>
      <CompatHealth compat={compat} onOpenRun={onOpenRun} />
    </TooltipProvider>,
  );
  return onOpenRun;
}

describe('formatProtocolRange: compact protocol bands (mirror of the server compat-view helper)', () => {
  it('renders a single major as v<n> and a real range with a dash', () => {
    expect(formatProtocolRange([1, 1])).toBe('v1');
    expect(formatProtocolRange([1, 2])).toBe('v1–2');
  });
});

describe('fleetOutcome: the worst pod outcome wins the fleet chip tone', () => {
  it('is incompatible over degraded over compatible', () => {
    expect(fleetOutcome({ groups: [] })).toBe('compatible');
    expect(
      fleetOutcome({
        groups: [{ token: 'a', pods: [], incompatible: false, degraded: true }],
      }),
    ).toBe('degraded');
    expect(
      fleetOutcome({
        groups: [
          { token: 'a', pods: [], incompatible: false, degraded: true },
          { token: 'b', pods: [], incompatible: true, degraded: false },
        ],
      }),
    ).toBe('incompatible');
  });
});

describe('CompatHealth: the fleet compatibility view', () => {
  it('says "no descriptors" when no worker has advertised, instead of an empty all-green claim', () => {
    renderPanel(report());
    expect(screen.getByText('no descriptors')).toBeTruthy();
  });

  it("opens the fleet popover with each pod's protocol band, outcome and red-flag reason", () => {
    renderPanel(
      report({
        groups: [
          {
            token: 'media',
            pods: [
              pod({
                instanceId: 'worker-media-1',
                protocol: 2,
                protocolRange: [2, 2],
                outcome: 'incompatible',
                negotiatedProtocol: null,
                incompatible: true,
                reason: 'no common protocol major: local speaks [1, 1], remote speaks [2, 2]',
                missingOnRemote: ['step.sleep'],
              }),
            ],
            incompatible: true,
            degraded: false,
          },
        ],
        incompatibleCount: 1,
      }),
    );
    fireEvent.click(screen.getByText('fleet'));
    expect(screen.getByText('worker-media-1')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(
      screen.getByText('no common protocol major: local speaks [1, 1], remote speaks [2, 2]'),
    ).toBeTruthy();
    expect(screen.getByText('missing on worker: step.sleep')).toBeTruthy();
  });

  it('lists blocked runs with their reason, and opens a run on click', () => {
    const onOpenRun = renderPanel(
      report({
        blocked: [
          {
            id: 'med-1',
            workflow: 'mediaTranscode',
            status: 'blocked',
            reason: "no compatible worker: requires capability 'step.stream'",
            requires: ['step.stream'],
            missingCapabilities: ['step.stream'],
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        blockedCount: 1,
      }),
    );
    fireEvent.click(screen.getByText('blocked'));
    fireEvent.click(screen.getByText('mediaTranscode'));
    expect(onOpenRun).toHaveBeenCalledWith('med-1');
  });
});

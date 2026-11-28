// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '../agora-kit/ui/tooltip';
import type {
  ConsoleProtection,
  MessagesMode,
  StepCheckpoint,
  WorkflowRun,
} from '../client/durable-client';
import { MESSAGES_DOCS, ProtectionBadges, STORE_DOCS } from './ProtectionBadges';
import { RunInfoPanel } from './RunInfoPanel';
import { StepDetailPanel } from './StepDetailPanel';

// No jest-dom in this package — plain DOM assertions only.

function wrap({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

function protection(over: Partial<ConsoleProtection> = {}): ConsoleProtection {
  return {
    messages: [{ transport: 'bullmq', mode: 'tenant-key', acceptPlain: false }],
    store: { codec: true, coverage: 'payloads' },
    redact: { run: false, checkpoint: false },
    ...over,
  };
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

afterEach(cleanup);

describe('ProtectionBadges', () => {
  const cases: Array<[MessagesMode, string]> = [
    ['tenant-key', 'Messages: sealed (tenant key)'],
    ['app-key', 'Messages: sealed (app key)'],
    ['crypto', 'Messages: sealed (crypto)'],
    ['secret', 'Messages: signed only (secret)'],
    ['plain', 'Messages: plain'],
  ];
  for (const [mode, label] of cases) {
    it(`labels ${mode} messages`, () => {
      render(
        <ProtectionBadges
          protection={protection({ messages: [{ transport: 'bullmq', mode, acceptPlain: true }] })}
        />,
        { wrapper: wrap },
      );
      const badge = byId('protection-messages');
      expect(badge?.textContent).toBe(label);
      expect(badge?.getAttribute('href')).toBe(MESSAGES_DOCS);
      // Only plain broker messages get the amber tone; the others stay neutral.
      expect(badge?.className.includes('text-warn')).toBe(mode === 'plain');
    });
  }

  it('names the weakest mode across transports, and "mixed" across seals', () => {
    const { rerender } = render(
      <ProtectionBadges
        protection={protection({
          messages: [
            { transport: 'bullmq', mode: 'tenant-key', acceptPlain: false },
            { transport: 'control plane', mode: 'secret', acceptPlain: false },
          ],
        })}
      />,
      { wrapper: wrap },
    );
    expect(byId('protection-messages')?.textContent).toBe('Messages: signed only (secret)');
    rerender(
      <ProtectionBadges
        protection={protection({
          messages: [
            { transport: 'bullmq', mode: 'tenant-key', acceptPlain: false },
            { transport: 'control plane', mode: 'app-key', acceptPlain: false },
          ],
        })}
      />,
    );
    expect(byId('protection-messages')?.textContent).toBe('Messages: sealed (mixed)');
  });

  it('labels the store by coverage, and plain without a codec', () => {
    const { rerender } = render(<ProtectionBadges protection={protection()} />, { wrapper: wrap });
    expect(byId('protection-store')?.textContent).toBe('Store: encrypted (input/output)');
    expect(byId('protection-store')?.getAttribute('href')).toBe(STORE_DOCS);
    rerender(
      <ProtectionBadges
        protection={protection({ store: { codec: true, coverage: 'extended' } })}
      />,
    );
    expect(byId('protection-store')?.textContent).toBe('Store: encrypted (extended)');
    rerender(
      <ProtectionBadges protection={protection({ store: { codec: false, coverage: null } })} />,
    );
    expect(byId('protection-store')?.textContent).toBe('Store: plain');
    expect(byId('protection-store')?.className.includes('text-warn')).toBe(false);
  });

  it('shows no messages badge without a broker, and no store badge when it is not known', () => {
    render(
      <ProtectionBadges
        protection={protection({
          messages: [],
          store: undefined,
          redact: { run: true, checkpoint: false },
        })}
      />,
      { wrapper: wrap },
    );
    expect(byId('protection-messages')).toBeNull();
    expect(byId('protection-store')).toBeNull();
    expect(byId('protection-redact')?.textContent).toBe('Redacted');
  });

  it('renders nothing without a descriptor', () => {
    render(<ProtectionBadges protection={undefined} />, { wrapper: wrap });
    expect(byId('protection-badges')).toBeNull();
    expect(screen.queryByText(/Messages:/)).toBeNull();
  });
});

const run: WorkflowRun = {
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'failed',
  input: { card: '[redacted]' },
  output: { ok: true },
  error: { message: 'boom' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  redactedFields: ['input'],
};

const step: StepCheckpoint = {
  seq: 1,
  name: 'charge',
  kind: 'local',
  status: 'failed',
  attempts: 1,
  input: { amount: 10 },
  output: '[hidden]',
  error: { message: 'declined' },
  events: [{ at: 1, level: 'info', message: 'charging' } as never],
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  redactedFields: ['output'],
};

describe('field markers', () => {
  it('RunInfoPanel locks the encrypted fields and marks the redacted ones', () => {
    render(<RunInfoPanel run={run} onClose={() => {}} encrypted={['input', 'output']} />, {
      wrapper: wrap,
    });
    expect(byId('encrypted-input')?.getAttribute('aria-label')).toBe(
      'Encrypted at rest; the console shows it decrypted',
    );
    expect(byId('encrypted-output')).not.toBeNull();
    expect(byId('encrypted-error')).toBeNull();
    expect(byId('redacted-input')?.textContent).toBe('hidden by redact');
    expect(byId('redacted-output')).toBeNull();
  });

  it('StepDetailPanel marks error and events under extended coverage', () => {
    render(
      <StepDetailPanel
        step={step}
        run={run}
        onClose={() => {}}
        encrypted={['input', 'output', 'error', 'events', 'progress']}
      />,
      { wrapper: wrap },
    );
    for (const field of ['input', 'output', 'error', 'events']) {
      expect(byId(`encrypted-${field}`), field).not.toBeNull();
    }
    expect(byId('redacted-output')).not.toBeNull();
    expect(byId('redacted-input')).toBeNull();
  });

  it('shows no marker when nothing is known', () => {
    render(<RunInfoPanel run={{ ...run, redactedFields: undefined }} onClose={() => {}} />, {
      wrapper: wrap,
    });
    expect(document.querySelector('[data-testid^="encrypted-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="redacted-"]')).toBeNull();
  });
});

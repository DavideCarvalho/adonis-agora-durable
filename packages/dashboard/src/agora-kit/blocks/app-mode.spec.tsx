// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppModeBadge,
  actionsUnavailableReason,
  FederatedNotice,
  federatedDescription,
} from './app-mode';

afterEach(cleanup);

describe('app mode', () => {
  it('describes where a federated app runs its actions', () => {
    expect(federatedDescription('Entre Textos', 'app')).toContain('sent to Entre Textos');
    expect(federatedDescription('Entre Textos', 'none')).toContain('Read-only here');
    expect(actionsUnavailableReason('ET', { mode: 'federated', actions: 'none' })).toContain(
      'read-only',
    );
    expect(actionsUnavailableReason('ET', { mode: 'federated', actions: 'app' })).toBeUndefined();
    expect(actionsUnavailableReason('ET', { mode: 'control-plane' })).toBeUndefined();
  });

  it('badges and notices only federated apps', () => {
    const { rerender } = render(
      <>
        <AppModeBadge appLabel="ET" mode="federated" actions="app" />
        <FederatedNotice appLabel="ET" mode="federated" actions="app" />
      </>,
    );
    expect(screen.getByText('federated')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('sent to ET');
    rerender(
      <>
        <AppModeBadge appLabel="ET" mode="control-plane" />
        <FederatedNotice appLabel="ET" />
      </>,
    );
    expect(screen.queryByText('federated')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
});

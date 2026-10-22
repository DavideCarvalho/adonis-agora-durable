// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FanMemberPlaceholder } from './SpansTimeline';

describe('FanMemberPlaceholder', () => {
  it('reads loading while its page is in flight', () => {
    render(
      <FanMemberPlaceholder index={4} page={{ isError: false, error: null, refetch: vi.fn() }} />,
    );
    expect(screen.getByText('#5 loading…')).toBeTruthy();
  });

  it("shows a failed page's error and refetches it on retry", () => {
    const refetch = vi.fn();
    render(
      <FanMemberPlaceholder
        index={0}
        page={{ isError: true, error: new Error('503 Service Unavailable'), refetch }}
      />,
    );
    expect(screen.getByText(/#1 couldn't load: 503 Service Unavailable/)).toBeTruthy();
    expect(screen.queryByText(/loading/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

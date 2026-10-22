// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorBlock } from './StepDetailPanel';

describe('ErrorBlock', () => {
  it('shows the message, the code and the details of a failure', () => {
    render(
      <ErrorBlock
        error={{
          message: 'line 3 is invalid',
          code: 'invalid_line',
          details: { issues: [{ path: ['amount'], message: 'Expected number' }] },
        }}
      />,
    );

    expect(screen.getByText('line 3 is invalid')).toBeTruthy();
    expect(screen.getByText('invalid_line')).toBeTruthy();
    expect(screen.getByText('error details')).toBeTruthy();
    expect(document.body.textContent).toContain('Expected number');
  });

  it('shows no details section for a failure without details', () => {
    render(<ErrorBlock error={{ message: 'boom' }} />);

    expect(screen.queryByText('error details')).toBeNull();
  });
});

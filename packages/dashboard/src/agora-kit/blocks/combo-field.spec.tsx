// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComboMultiSelect, ComboSelect, comboItems, comboMatches } from './combo-field';

afterEach(cleanup);

const defaultQueue = { value: 'default', label: 'Default' };
const emailsQueue = { value: 'emails', label: 'E-mails', hint: '12 jobs' };
const reportsQueue = { value: 'relatorios', label: 'Relatórios' };
const queues = [defaultQueue, emailsQueue, reportsQueue];

describe('comboMatches / comboItems', () => {
  it('matches label, value and hint, ignoring accents and case', () => {
    expect(comboMatches(reportsQueue, 'RELATORIO')).toBe(true);
    expect(comboMatches(emailsQueue, '12')).toBe(true);
    expect(comboMatches(emailsQueue, 'mails jobs')).toBe(true);
    expect(comboMatches(defaultQueue, 'mail')).toBe(false);
  });

  it('keeps selected values outside the list and offers typed text when creatable', () => {
    expect(comboItems(queues, '', { selected: ['legacy'] })).toEqual([
      'default',
      'emails',
      'relatorios',
      'legacy',
    ]);
    expect(comboItems(queues, 'billing', { creatable: true })).toEqual(['billing']);
    expect(comboItems(queues, 'billing')).toEqual([]);
    expect(comboItems(queues, 'emails', { creatable: true })).toEqual(['emails']);
  });
});

async function type(input: HTMLElement, text: string) {
  await act(async () => {
    input.focus();
    // happy-dom input events don't open Base UI's popup; ArrowDown does (as it does for users).
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: text } });
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function pick(name: RegExp | string) {
  const option = await screen.findByRole('option', { name });
  await act(async () => {
    fireEvent.click(option);
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe('ComboSelect', () => {
  it('filters as you type and reports the picked value', async () => {
    const onValueChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    await type(screen.getByRole('combobox', { name: 'Queue' }), 'relat');
    expect(screen.queryByRole('option', { name: /Default/ })).toBeNull();
    await pick(/Relatórios/);
    expect(onValueChange).toHaveBeenCalledWith('relatorios');
  });

  it('picks typed text when creatable', async () => {
    const onValueChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value={null}
        onValueChange={onValueChange}
        creatable
      />,
    );
    await type(screen.getByRole('combobox', { name: 'Queue' }), 'billing');
    await pick('Use “billing”');
    expect(onValueChange).toHaveBeenCalledWith('billing');
  });

  it('forwards the query for server-side search', async () => {
    const onQueryChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Tenant"
        options={[]}
        value={null}
        onValueChange={() => {}}
        onQueryChange={onQueryChange}
        loading
      />,
    );
    await type(screen.getByRole('combobox', { name: 'Tenant' }), 'acme');
    expect(onQueryChange).toHaveBeenLastCalledWith('acme');
    expect(await screen.findByText('Loading…')).toBeTruthy();
  });
});

function Harness({ onChange }: { onChange: (v: string[]) => void }) {
  const [value, setValue] = useState<string[]>(['emails']);
  return (
    <ComboMultiSelect
      aria-label="Queues"
      options={queues}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('ComboMultiSelect', () => {
  it('adds values as chips and removes them', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText('E-mails')).toBeTruthy();
    await type(screen.getByRole('combobox', { name: 'Queues' }), 'def');
    await pick(/Default/);
    expect(onChange).toHaveBeenLastCalledWith(['emails', 'default']);
    const chip = screen.getByText('E-mails').closest('[data-slot=combobox-chip]');
    const remove = chip?.querySelector('[data-slot=combobox-chip-remove]') as HTMLElement;
    await act(async () => {
      fireEvent.click(remove);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onChange).toHaveBeenLastCalledWith(['default']);
  });
});

function ServerHarness({ onChange }: { onChange: (v: string | null) => void }) {
  const [query, setQuery] = useState('');
  const [value, setValue] = useState<string | null>(null);
  // A fresh array every render, filtered "on the server": the typed text must survive both.
  const options = ['alpha', 'beta', 'gamma'].filter((o) => o.includes(query));
  return (
    <ComboSelect
      aria-label="Doc"
      options={options}
      value={value}
      onQueryChange={setQuery}
      onValueChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('ComboSelect with server-side options', () => {
  it('keeps the typed text while options change', async () => {
    const onChange = vi.fn();
    render(<ServerHarness onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Doc' }) as HTMLInputElement;
    await type(input, 'gam');
    expect(input.value).toBe('gam');
    expect(screen.queryByRole('option', { name: 'alpha' })).toBeNull();
    await pick('gamma');
    expect(onChange).toHaveBeenLastCalledWith('gamma');
  });
});

describe('ComboSelect input text', () => {
  it('shows the selected label, follows outside changes and late labels', async () => {
    const { rerender } = render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value="relatorios"
        onValueChange={() => {}}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Queue' }) as HTMLInputElement;
    expect(input.value).toBe('Relatórios');
    rerender(
      <ComboSelect aria-label="Queue" options={queues} value="emails" onValueChange={() => {}} />,
    );
    expect(input.value).toBe('E-mails');
    rerender(<ComboSelect aria-label="Queue" options={[]} value="late" onValueChange={() => {}} />);
    expect(input.value).toBe('late');
    rerender(
      <ComboSelect
        aria-label="Queue"
        options={[{ value: 'late', label: 'Late label' }]}
        value="late"
        onValueChange={() => {}}
      />,
    );
    expect(input.value).toBe('Late label');
  });

  it('goes back to the selected label when closed without a pick', async () => {
    render(
      <ComboSelect aria-label="Queue" options={queues} value="emails" onValueChange={() => {}} />,
    );
    const input = screen.getByRole('combobox', { name: 'Queue' }) as HTMLInputElement;
    await type(input, 'rel');
    expect(input.value).toBe('rel');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(input.value).toBe('E-mails');
  });
});

describe('ComboSelect creatable, leaving the field', () => {
  it('keeps typed text as the value on blur, and a pick still wins', async () => {
    const onValueChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value={null}
        onValueChange={onValueChange}
        creatable
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Queue' });
    await type(input, 'billing');
    await act(async () => {
      fireEvent.blur(input);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onValueChange).toHaveBeenLastCalledWith('billing');
  });

  it('does not commit typed text without creatable, nor on Escape', async () => {
    const onValueChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Queue' });
    await type(input, 'billing');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('ComboSelect creatable, near matches', () => {
  it('resolves typed text to an existing option ignoring accents and case', async () => {
    const onValueChange = vi.fn();
    render(
      <ComboSelect
        aria-label="Queue"
        options={queues}
        value={null}
        onValueChange={onValueChange}
        creatable
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Queue' });
    await type(input, 'RELATORIOS');
    await act(async () => {
      fireEvent.blur(input);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onValueChange).toHaveBeenLastCalledWith('relatorios');
  });
});

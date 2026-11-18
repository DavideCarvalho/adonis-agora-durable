// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComboMultiSelect, ComboSelect, comboItems, comboMatches } from './combo-field';

afterEach(cleanup);

const queues = [
  { value: 'default', label: 'Default' },
  { value: 'emails', label: 'E-mails', hint: '12 jobs' },
  { value: 'relatorios', label: 'Relatórios' },
];

describe('comboMatches / comboItems', () => {
  it('matches label, value and hint, ignoring accents and case', () => {
    expect(comboMatches(queues[2], 'RELATORIO')).toBe(true);
    expect(comboMatches(queues[1], '12')).toBe(true);
    expect(comboMatches(queues[1], 'mails jobs')).toBe(true);
    expect(comboMatches(queues[0], 'mail')).toBe(false);
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

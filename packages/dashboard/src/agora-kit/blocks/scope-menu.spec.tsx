// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopeMenu } from './scope-menu';

afterEach(cleanup);

const TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Every app you can see',
  search: 'Search apps',
  empty: 'No apps.',
};

const ITEMS = [
  { id: 'hub', label: 'Hub' },
  { id: 'shop', label: 'Shop', hint: 'federated' },
  { id: 'blog', label: 'Blog' },
];

function setup(current: string | undefined = 'hub') {
  const onChoose = vi.fn();
  render(
    <ScopeMenu
      items={ITEMS}
      all={false}
      current={current}
      text={TEXT}
      labelOf={(id) => ITEMS.find((i) => i.id === id)?.label ?? id}
      onChoose={onChoose}
    />,
  );
  return { onChoose };
}

describe('ScopeMenu', () => {
  it('names the button "noun: label" for screen readers', () => {
    setup();
    expect(screen.getByRole('button', { name: 'App: Hub' })).toBeTruthy();
  });

  it('search matches the hint too', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'App: Hub' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'federated' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Shop');
  });

  it('keeps the highlight on a real option when the list shrinks, so Enter still picks', () => {
    const { onChoose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'App: Hub' }));
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // on "Blog", the third option
    fireEvent.change(input, { target: { value: 'sh' } }); // one option left
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChoose).toHaveBeenCalledWith('shop');
  });

  it('returns focus to the button after a pick', () => {
    setup();
    const button = screen.getByRole('button', { name: 'App: Hub' });
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Blog/ }));
    expect(document.activeElement).toBe(button);
  });
});

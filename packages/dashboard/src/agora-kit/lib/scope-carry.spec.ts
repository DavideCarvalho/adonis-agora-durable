import { describe, expect, it } from 'vitest';
import { withPageScope } from './scope-carry';

const at = (href: string) => {
  const url = new URL(href);
  return { href: url.href, search: url.search };
};

describe('withPageScope', () => {
  it('carries ?app= and ?tenant= to another console on this origin, relative stays relative', () => {
    const here = at('https://hub.example.com/telescope?app=shop&tenant=acme#/pulse');
    expect(withPageScope('/agent/dashboard/', here)).toBe('/agent/dashboard/?app=shop&tenant=acme');
    expect(withPageScope('/durable/#runs', here)).toBe('/durable/?app=shop&tenant=acme#runs');
  });

  it('keeps an absolute href absolute', () => {
    const here = at('https://hub.example.com/telescope?app=shop');
    expect(withPageScope('https://hub.example.com/agent/dashboard/', here)).toBe(
      'https://hub.example.com/agent/dashboard/?app=shop',
    );
  });

  it('never overrides what the href sets, nor touches other origins', () => {
    const here = at('https://hub.example.com/telescope?app=shop');
    expect(withPageScope('/agent/?app=blog', here)).toBe('/agent/?app=blog');
    expect(withPageScope('https://shop.example.com/telescope', here)).toBe(
      'https://shop.example.com/telescope',
    );
  });

  it('without a scope on this page, hrefs are unchanged', () => {
    const here = at('https://hub.example.com/telescope#/pulse');
    expect(withPageScope('/agent/dashboard/', here)).toBe('/agent/dashboard/');
  });

  it('leaves hash-only links alone: they keep the page query by themselves', () => {
    const here = at('https://hub.example.com/agent/?app=shop#overview');
    expect(withPageScope('#runs', here)).toBe('#runs');
  });

  it('a same-console page link keeps the scope too', () => {
    const here = at('https://hub.example.com/agent/?app=shop#overview');
    expect(withPageScope('/agent/#runs', here)).toBe('/agent/?app=shop#runs');
  });
});

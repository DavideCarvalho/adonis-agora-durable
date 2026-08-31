import { describe, expect, it } from 'vitest';
import {
  BASE_PLACEHOLDER,
  CONFIG_ELEMENT_ID,
  type InjectedConfig,
  renderIndexHtml,
} from '../../src/dashboard/spa.js';

const BUILT_HTML = `<!doctype html>
<html><head>
<script type="module" crossorigin src="${BASE_PLACEHOLDER}assets/index-abc123.js"></script>
</head><body><div id="root"></div></body></html>`;

/** Parse the injected data block back out, the way the client does. */
function injectedConfig(html: string): InjectedConfig {
  const match = new RegExp(`id="${CONFIG_ELEMENT_ID}">([^]*?)</script>`).exec(html);
  if (match === null) throw new Error('no config block injected');
  return JSON.parse(match[1] ?? '') as InjectedConfig;
}

describe('renderIndexHtml', () => {
  it('rewrites the Vite placeholder base to the mount path', () => {
    const html = renderIndexHtml(BUILT_HTML, '/ops/durable', '/ops/durable/api');
    expect(html).toContain('/ops/durable/assets/index-abc123.js');
    expect(html).not.toContain(BASE_PLACEHOLDER);
  });

  it('hands the client its base and api as a JSON data block', () => {
    expect(injectedConfig(renderIndexHtml(BUILT_HTML, '/d', '/d/api'))).toEqual({
      base: '/d',
      api: '/d/api',
    });
  });

  it('injects a DATA block, never an executable inline script', () => {
    // A host CSP of `script-src 'self' 'nonce-…'` drops an inline script without a word, the
    // client falls back to `/durable/api`, and on any other mount every request 404s from a page
    // that rendered fine. `type="application/json"` is never executed, so no policy can refuse it.
    const html = renderIndexHtml(BUILT_HTML, '/d', '/d/api');
    const injected = (html.match(/<script\b[^>]*>/g) ?? []).filter((t) =>
      t.includes(CONFIG_ELEMENT_ID),
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('type="application/json"');
    expect(html).not.toContain('window.__DURABLE_');
  });

  it('keeps an EMPTY base for a root mount rather than dropping it', () => {
    expect(injectedConfig(renderIndexHtml(BUILT_HTML, '', '/api')).base).toBe('');
  });

  it('escapes a value that would otherwise close the data block early', () => {
    const html = renderIndexHtml(BUILT_HTML, '/d', '/d</script><b>');
    expect(html.split('</script>')).toHaveLength(3); // Vite's module script + ours.
    expect(injectedConfig(html).api).toBe('/d</script><b>');
  });

  it('still injects when the document has no head', () => {
    expect(injectedConfig(renderIndexHtml('<div id="root"></div>', '/d', '/d/api')).api).toBe(
      '/d/api',
    );
  });
});

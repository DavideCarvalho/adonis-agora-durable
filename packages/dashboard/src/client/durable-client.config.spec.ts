import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_ELEMENT_ID, durableClient } from './durable-client.js';

/**
 * Where the client gets its API base from: the provider's JSON data block, else `/durable/api`. The block exists because a host CSP with
 * `script-src 'self' 'nonce-…'` refuses the inline script the globals used to arrive in, and the
 * console then 404s on every request while rendering perfectly.
 */

function injectConfig(config: Record<string, unknown>): void {
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = CONFIG_ELEMENT_ID;
  el.textContent = JSON.stringify(config);
  document.head.appendChild(el);
}

/** Stub fetch and return the URLs it was asked for. */
function captureFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return urls;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.getElementById(CONFIG_ELEMENT_ID)?.remove();
});

describe('the injected config block', () => {
  it('is where the API base comes from', async () => {
    injectConfig({ base: '/ops/durable', api: '/ops/durable/api' });
    const urls = captureFetch();
    await durableClient.workers();
    expect(urls[0]?.startsWith('/ops/durable/api/')).toBe(true);
  });

  it('falls back to /durable/api when there is no block', async () => {
    const urls = captureFetch();
    await durableClient.workers();
    expect(urls[0]?.startsWith('/durable/api/')).toBe(true);
  });

  it('ignores a block that is not JSON rather than crashing the console', async () => {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = CONFIG_ELEMENT_ID;
    el.textContent = '{not json';
    document.head.appendChild(el);
    const urls = captureFetch();
    await durableClient.workers();
    expect(urls[0]?.startsWith('/durable/api/')).toBe(true);
  });
});

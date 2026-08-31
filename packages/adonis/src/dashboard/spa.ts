/**
 * Pure helpers for mounting/serving the `@adonis-agora/durable-dashboard` React SPA — split out so
 * they're unit-testable without booting AdonisJS. `dashboard_provider.ts` is a thin HTTP shell around
 * these. Mirrors `@adonis-agora/media-dashboard`'s `provider/serve.ts` byte-for-byte in shape, so the
 * two packages' "serve a Vite SPA from an AdonisJS provider" story stays one pattern across the Agora
 * ecosystem.
 */

/** Placeholder base Vite bakes into asset URLs (`packages/dashboard/vite.config.ts`); rewritten to the
 *  configured dashboard `path` at serve time — the SAME built bundle mounts at any path with no rebuild. */
export const BASE_PLACEHOLDER = '/__DURABLE_DASHBOARD__/';

export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Content type for a served asset filename, defaulting to octet-stream. */
export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** `id` of the JSON data block `renderIndexHtml` injects; `src/client/durable-client.ts` reads it. */
export const CONFIG_ELEMENT_ID = 'durable-dashboard-config';

/** What the page tells the SPA about the deployment it is mounted in. */
export interface InjectedConfig {
  /** UI mount base (`/durable`; `''` for a root mount). */
  base: string;
  /** JSON API base (`/durable/api`). */
  api: string;
}

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at the configured mount
 * path, and hand the SPA the two values `src/client/durable-client.ts` builds URLs from — the UI
 * mount base and the JSON API base.
 *
 * They go in as a JSON DATA BLOCK (`<script type="application/json">`), not as an inline script
 * assigning `window.__DURABLE_BASE__`/`__DURABLE_API__`. A data block is never executed, so no
 * Content-Security-Policy can refuse it; an inline script IS, and a host with
 * `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s `@nonce`, the recommended setup) silently
 * dropped ours. The globals were then undefined, the SPA fell back to `/durable/api`, and on any
 * other mount path EVERY request from a console that had rendered perfectly well answered 404 —
 * the module script Vite emits is a same-origin file, so the page itself kept loading and the
 * failure looked like a routing bug rather than a policy one. The globals are still read by the
 * client as a fallback (tests, hand-embedding), but this is no longer how the provider speaks.
 */
export function renderIndexHtml(html: string, basePath: string, apiBasePath: string): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  const config: InjectedConfig = { base: basePath, api: apiBasePath };
  // `<` escaped as `\u003c` inside the JSON: a data block ends at the first `</script`, and a
  // config value must not be able to close it early. Valid JSON either way.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const inject = `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}

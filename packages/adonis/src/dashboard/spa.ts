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

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at the configured mount
 * path, and inject the two globals `src/client/durable-client.ts` reads
 * (`window.__DURABLE_BASE__`/`window.__DURABLE_API__`) — the SAME globals
 * `@dudousxd/nestjs-durable-dashboard`'s own UI controller injects, so the SPA's client code (ported
 * verbatim) needs no adaptation for which server it's running against.
 */
export function renderIndexHtml(html: string, basePath: string, apiBasePath: string): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath}/`);
  const inject = `<script>window.__DURABLE_BASE__=${JSON.stringify(basePath)};window.__DURABLE_API__=${JSON.stringify(apiBasePath)};</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}

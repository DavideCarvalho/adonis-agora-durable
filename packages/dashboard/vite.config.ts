import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the dashboard SPA into `dist/spa`. `base` is a placeholder (`/__DURABLE_DASHBOARD__/`) the
 * AdonisJS provider (`packages/adonis/src/dashboard/spa.ts`) rewrites at serve time to the configured
 * mount path, so the same built bundle works mounted anywhere (`/durable`, `/ops/durable`, ...) with no
 * rebuild — the same pattern `@adonis-agora/media-dashboard` uses for the identical problem.
 */
export default defineConfig({
  base: '/__DURABLE_DASHBOARD__/',
  plugins: [react()],
  // CSS-referenced assets (the kit's bundled fonts) load relative to the stylesheet: the provider
  // rewrites the base placeholder in index.html only, so an absolute `/__DURABLE_DASHBOARD__/…` font
  // URL inside the CSS would 404 once mounted.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    sourcemap: true,
  },
});

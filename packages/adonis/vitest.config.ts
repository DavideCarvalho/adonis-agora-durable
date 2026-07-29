import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.{spec,test}.ts'],
    pool: 'forks',
    globalSetup: ['./test/setup/sqlite-preflight.ts'],
  },
});

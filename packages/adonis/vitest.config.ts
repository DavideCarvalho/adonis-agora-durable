import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.{spec,test}.ts'],
    pool: 'forks',
    // Generous upper bounds: the Postgres and Redis suites run against real servers, and on a shared
    // CI runner a schema create or a poll round can take seconds. A test's own assertions bound what
    // it checks; these only stop a genuinely hung one.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: [
      './test/setup/sqlite-preflight.ts',
      './test/setup/postgres-cleanup.ts',
      './test/setup/mysql-cleanup.ts',
    ],
  },
});

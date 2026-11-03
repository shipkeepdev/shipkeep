import { defineConfig } from 'vitest/config';

import { swcPlugin } from './vitest.config.mjs';

// Integration tests against real services (PostgreSQL through Testcontainers or the CI service).
// Run with `pnpm test:integration`.
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-integration',
  plugins: [swcPlugin],
  test: {
    name: 'api-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    setupFiles: ['src/test-setup.integration.ts'],
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
}));

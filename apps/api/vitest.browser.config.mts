import { defineConfig } from 'vitest/config';

import { swcPlugin } from './vitest.config.mjs';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-browser',
  plugins: [swcPlugin],
  test: {
    name: 'api-browser',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.browser.spec.ts'],
    setupFiles: ['src/test-setup.integration.ts'],
    reporters: ['default'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
}));

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on decorator metadata, which esbuild cannot emit; swc transforms the sources.
export const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { decoratorMetadata: true, legacyDecorator: true },
    keepClassNames: true,
  },
});

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [swcPlugin],
  test: {
    name: 'api',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    // Integration tests have their own config (vitest.integration.config.mts).
    exclude: ['**/node_modules/**', 'src/**/*.integration.spec.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));

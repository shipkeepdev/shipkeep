import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.spec.ts'],
    rules: {
      // supertest and vitest helpers return loosely typed values; assertions narrow them.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
];

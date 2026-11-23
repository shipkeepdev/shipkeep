import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // Astro writes its generated types to .astro, and the site to dist.
    ignores: ['.astro/**', 'dist/**'],
  },
];

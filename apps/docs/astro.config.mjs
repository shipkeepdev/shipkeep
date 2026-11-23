// The documentation site (ADR 0027, #246): static pages built with Starlight from Markdown, with
// the landing page's Cadre look. Installation is written once, in docs/INSTALL.md, and copied here
// at build time by scripts/sync-repo-docs.mjs.
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  // No image processing: the pages use SVG and the demo recording as they are.
  image: { service: passthroughImageService() },
  // Nothing here reports usage anywhere.
  telemetry: false,
  integrations: [
    starlight({
      title: 'Shipkeep',
      description:
        'Self-hosted platform to deploy applications on servers you own, without leaving the root key in a web panel.',
      logo: {
        dark: './src/assets/mark-dark.svg',
        light: './src/assets/mark-light.svg',
        alt: 'Shipkeep',
      },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/shipkeepdev/shipkeep' },
      ],
      editLink: { baseUrl: 'https://github.com/shipkeepdev/shipkeep/edit/main/apps/docs/' },
      lastUpdated: false,
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/cadre.css',
      ],
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Introduction', slug: 'index' },
            { label: 'Install', slug: 'start/install' },
            { label: 'First deployment', slug: 'start/first-deployment' },
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Reference', items: [{ label: 'shipkeep.yml', slug: 'reference/shipkeep-yml' }] },
      ],
    }),
  ],
});

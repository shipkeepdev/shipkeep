# Documentation site

The user documentation of Shipkeep (ADR 0027), built with [Starlight](https://starlight.astro.build) into static pages.

- Pages are Markdown files in `src/content/docs`. The sidebar is set in `astro.config.mjs`.
- The installation guide is `docs/INSTALL.md`, which the installer and the README link to. `scripts/sync-repo-docs.mjs` copies it into the site at build time, so edit that file, never the copy (`src/content/docs/start/install.md`, not committed).
- `src/styles/cadre.css` gives the site the landing page's look: black, white and grays, Geist, hairline borders.
- Say only what is true: what is not built yet says "planned", and the prerelease note on the introduction stays until a stable release.

```sh
pnpm nx run docs:serve    # http://localhost:4321, reloads on change
pnpm nx run docs:build    # apps/docs/dist
```

Publishing the site, and its domain, are the maintainer's step.

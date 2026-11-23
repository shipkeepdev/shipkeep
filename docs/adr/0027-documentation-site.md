# ADR 0027: Documentation site

- Status: Accepted
- Date: 2026-11-23

## Context

The first stable version needs user documentation that a new user can follow alone to install Shipkeep and deploy (M10.4, #246). It covers installation, concepts, the `shipkeep.yml` reference generated from the JSON Schema, the CLI reference and a migration guide.

Today, user documentation lives in `docs/INSTALL.md` and the README:

- `docs/INSTALL.md` is linked by the installer (`install.sh` prints a link to it), by the README and by the landing page.
- The rest of `docs/` is for contributors: product, architecture, specification, threat model, plan and decisions.
- The landing page (`apps/landing`) is hand-written HTML with no build step, in the "Cadre" design.

## Decision

**A static site built with Starlight**, in `apps/docs`.

- Starlight (MIT), on Astro (MIT), turns Markdown into a static documentation site. It brings the navigation, the table of contents of each page, light and dark themes, and a search that runs in the browser on an index built with the site (Pagefind, MIT). It has no server and no external service.
- Both are development dependencies: the built site is HTML, CSS and a little JavaScript, and nothing of it ships in the control plane image or the binaries. The license check (ADR 0014) covers production dependencies only.
- Images are not processed (`passthroughImageService`), and telemetry is off. The site loads nothing from another origin. Geist and Geist Mono are bundled from `@fontsource-variable`, as in the web UI (ADR 0014: OFL-1.1 fonts, approved).
- The look follows the landing page: black, white and grays, Geist, hairline borders, the chevron mark and the uppercase wordmark (`src/styles/cadre.css`).
- Nx builds it (`nx run docs:build`), so CI builds it on every pull request that touches it.

**Each text is written once.**

- `docs/INSTALL.md` stays the installation guide, where the installer and the README link to it. `scripts/sync-repo-docs.mjs` copies it into the site at build time, takes its first heading off, and turns its links to other repository files into links to GitHub. The copy is not committed, and the page's edit link points to `docs/INSTALL.md`.
- The `shipkeep.yml` reference is generated from the JSON Schema by `tools/gen/config-reference.mjs`, as part of `pnpm gen`, and CI checks that it is current. The schema says what a field is; the generator adds what the control plane does with it today (defaults, and the fields it refuses until they are applied, SPEC 2.2), from two lists kept in step with the control plane.
- The CLI reference will be generated from the CLI the same way.

**Publishing is the maintainer's step.** The site builds to `apps/docs/dist`, which any static host serves. Where it is served, and under which domain (#202), is decided when it goes online. Until then the pages set no canonical address and no sitemap.

**Alternatives considered.**

- More hand-written HTML, like the landing page: no dependency, but every page, the navigation and the search would be code to write and maintain.
- VitePress or Docusaurus: comparable, but Docusaurus needs React, and Starlight's defaults (accessibility, search with no service, no client framework) fit best.
- GitHub's rendering of `docs/`: no navigation built for users, and it mixes user guides with contributor documents.

## Consequences

- `apps/docs` adds close to 300 development packages to the lockfile, counting the builds of the Astro compiler, Pagefind and sharp for each platform. They are under the same supply-chain policy as the others: seven days minimum age, and no install scripts beyond the allow-list. None of them is in the control plane image or the binaries; the published site carries only the client scripts of Starlight and Pagefind, both MIT.
- A guide can be read in the repository and on the site, without two copies to keep in step.
- The landing page and the site share a look but no code: a change to the design is made in both.

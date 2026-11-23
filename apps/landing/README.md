# Landing page

Static marketing page, deployed on Vercel at <https://shipkeep.vercel.app> (project `shipkeep`, not linked to Git).

- `index.html` (English, the default, at `/`) and `fr/index.html` (French, at `/fr`) are static pages. Edit them directly: they have no build step. `/en`, the English page's former address, redirects to `/` (`vercel.json`).
- `site.css` holds the styles and `site.js` the interactions, with no dependency. `theme.js` applies the saved light or dark theme before the page is painted, the only thing the page stores. The page is dark unless the visitor chose light. `vercel.json` sets the Content-Security-Policy.
- The page follows the "Shipkeep Landing Cadre" design. Its examples use reserved names (`example.com`, `srv-par-1`) and the `shipkeep.yml` lines are valid against the JSON Schema.
- `og.jpg` is the image shown when a link to the site is shared: a 1200 × 630 screenshot of the top of the English page, in English like the shared page's title and description. The French page uses `og-fr.jpg`, the same from the French page. Both show the status line, so take them again whenever the status line, the navigation or the hero changes.

**Say only what is true.** The status line at the top stays until a stable release: it says that a prerelease can be tried and that the page describes more than that prerelease contains. Features that are not in the prerelease say "Planned" or "Target" ("Prévu", "Objectif"); the ledger of numbers and the deployment animations are examples, and the ledger says so. The Shipkeep column of the comparison is the first release's target, and the note under the table says so; recheck the other columns against each project's documentation before changing that date, and keep one primary source link per cell (the project's own docs, license file or repository) under the table. No star counts. Installation is a link to `docs/INSTALL.md`, never a command on the page.

**Search engines and AI assistants.** Both pages carry a title, description, canonical and `hreflang` links (with `x-default` on the English page, `/`), Open Graph tags and JSON-LD (`SoftwareApplication`). Structured data only describes what the page shows: add a `FAQPage` entry only with a visible FAQ that it repeats word for word. `robots.txt`, `sitemap.xml` and `llms.txt` sit next to the pages. Every URL uses `https://shipkeep.vercel.app`; if the site moves to its own domain, update them all, and bump `lastmod` in the sitemap when a page changes.

Deploy from a copy, so that `.vercel` and `.env.local` stay out of the repository:

```sh
cp -r apps/landing /tmp/landing && cd /tmp/landing
vercel link --project shipkeep
vercel deploy --prod
```

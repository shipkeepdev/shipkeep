# Landing page

Static marketing page, deployed on Vercel at <https://shipkeep.vercel.app> (project `shipkeep`, not linked to Git).

- `index.html` (French, the default) and `en/index.html` are static pages. Edit them directly: they have no build step.
- `site.js` holds the interactions, with no dependency. `vercel.json` sets the Content-Security-Policy.
- `hero-fr.jpg` and `hero-en.jpg` are screenshots of the dashboard mockup, captioned as fictional data.

**Say only what is true.** The status line at the top stays until a stable release: it says that a prerelease can be tried and that the page describes more than that prerelease contains. The "requests served" card is an example and stays labeled as one. The Shipkeep column of the comparison is the first release's target, and the note under the table says so; recheck the other columns against each project's documentation before changing that date, and keep one primary source link per cell (the project's own docs, license file or repository) under the table. No star counts. Installation is a link to `docs/INSTALL.md`, never a command on the page.

**Search engines and AI assistants.** Both pages carry a title, description, canonical and `hreflang` links (with `x-default` on the English page), Open Graph tags and JSON-LD (`SoftwareApplication` and `FAQPage`). The JSON-LD questions and answers repeat the visible FAQ word for word: change both together. `robots.txt`, `sitemap.xml` and `llms.txt` sit next to the pages. Every URL uses `https://shipkeep.vercel.app`; if the site moves to its own domain, update them all, and bump `lastmod` in the sitemap when a page changes.

Deploy from a copy, so that `.vercel` and `.env.local` stay out of the repository:

```sh
cp -r apps/landing /tmp/landing && cd /tmp/landing
vercel link --project shipkeep
vercel deploy --prod
```

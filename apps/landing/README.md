# Landing page

Static marketing page, deployed on Vercel at <https://shipkeep.vercel.app> (project `shipkeep`, not linked to Git).

- `index.html` (French, the design's default) and `en/index.html` were rendered once from the Claude Design project "Maquettes Shipkeep landing et dashboard" and frozen. Edit them directly: they have no build step, and the design runtime is not shipped because it loads Babel from a CDN and builds code from strings.
- `site.js` holds the interactions, with no dependency. `vercel.json` sets the Content-Security-Policy.
- `hero-fr.jpg` and `hero-en.jpg` are screenshots of the dashboard mockup, captioned as fictional data.

**Say only what is true.** The status line at the top stays until Shipkeep can be installed. The "requests served" card is an example, at the owner's request, and stays labeled as one. The Shipkeep column of the comparison is the first release's target, and the note under the table says so; recheck the other columns against each project's documentation before changing that date. No star counts or install commands until they are real: `get.shipkeep.dev` must not appear before the domain is owned, since whoever registers it would be serving a command people pipe into a shell.

Deploy from a copy, so that `.vercel` and `.env.local` stay out of the repository:

```sh
cp -r apps/landing /tmp/landing && cd /tmp/landing
vercel link --yes --project shipkeep --scope samuelmbabhazis-projects
vercel deploy --prod --yes --scope samuelmbabhazis-projects
```

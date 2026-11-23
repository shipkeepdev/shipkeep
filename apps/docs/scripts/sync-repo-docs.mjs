// Copies the user guides that live in the repository into the site, so that each is written once
// (ADR 0027). docs/INSTALL.md stays where the installer and the README link to it; the site gets a
// copy at build time, with its title in front matter and its links to other repository files
// turned into links to GitHub. The copies are not committed (apps/docs/.gitignore).
//
//   node scripts/sync-repo-docs.mjs        from apps/docs, before `astro build` or `astro dev`

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(site, '../..');
const blob = 'https://github.com/shipkeepdev/shipkeep/blob/main/';
const edit = 'https://github.com/shipkeepdev/shipkeep/edit/main/';

/** Each guide: its file in the repository, and where and under which title the site shows it. */
const guides = [
  {
    source: 'docs/INSTALL.md',
    target: 'src/content/docs/start/install.md',
    title: 'Install',
    description:
      'Install the control plane, add a server, back up and upgrade a Shipkeep installation.',
  },
];

/** A link to another file of the repository, relative to the guide, becomes a link to GitHub. */
export function rewriteLinks(markdown, source) {
  return markdown.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, target) => {
    const [path, anchor] = target.split('#');
    const resolved = posix.normalize(posix.join(posix.dirname(source), path));
    if (resolved.startsWith('..'))
      throw new Error(`${source} links outside the repository: ${target}`);
    return `](${blob}${resolved}${anchor ? `#${anchor}` : ''})`;
  });
}

/** The guide without its first heading, which the site shows as the page title. */
export function withoutTitle(markdown) {
  return markdown.replace(/^# .*\n+/, '');
}

export async function sync() {
  for (const guide of guides) {
    const markdown = await readFile(join(root, guide.source), 'utf8');
    const front = [
      '---',
      `title: ${JSON.stringify(guide.title)}`,
      `description: ${JSON.stringify(guide.description)}`,
      `editUrl: ${JSON.stringify(edit + guide.source)}`,
      '---',
      '',
      `<!-- Copied from ${guide.source} by scripts/sync-repo-docs.mjs: edit that file instead. -->`,
      '',
    ].join('\n');
    const target = join(site, guide.target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, front + rewriteLinks(withoutTitle(markdown), guide.source));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await sync();

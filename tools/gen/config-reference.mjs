// Generates the shipkeep.yml reference of the documentation site from
// packages/config-schema/shipkeep.schema.json (ADR 0027). Run through `pnpm gen`. The output is
// committed and never edited by hand; CI checks that it is current.
//
// The schema says what a field is. What the control plane does with it today is in NOTES and
// DEFAULTS below, which follow SPEC 2.2 and the pipeline: keep them in step with
// `UNAPPLIED` (apps/api/src/modules/apps/domain/application.ts) and the defaults the pipeline uses.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaPath = join(root, 'packages', 'config-schema', 'shipkeep.schema.json');
const outPath = join(
  root,
  'apps',
  'docs',
  'src',
  'content',
  'docs',
  'reference',
  'shipkeep-yml.md',
);

/** What a field does today, when the schema alone would say more than Shipkeep does. */
const NOTES = {
  'build.type':
    'Only `image` works today. `dockerfile`, `railpack` and `nixpacks` describe builds, which are planned: the control plane refuses them.',
  'build.context': 'For builds, which are planned.',
  'build.dockerfile': 'For builds, which are planned.',
  'build.args': 'For builds, which are planned.',
  'run.healthcheck':
    'Each replica is probed on `run.port` until it is healthy. A replica that is not healthy before the deadline (the start period plus 2 minutes, at most 30 minutes) fails the deployment, and the previous release keeps serving.',
  'run.healthcheck.unhealthy_threshold': 'Accepted, not applied yet.',
  release:
    'Runs once per release, on the server of the first replica, before that replica starts. A non-zero exit fails the deployment. A rollback does not run it again.',
  'scale.placement.nodes': 'Server names. A replica goes only to one of them.',
  domains:
    'Each domain gets a certificate once its DNS record points to a server that runs the application. Wildcards are refused until DNS-01 exists.',
  secrets:
    'Set the values on the environment first: a deployment that names a secret with no value is refused before it starts.',
  volumes:
    'Refused for now: volumes are not mounted yet, so what an application wrote there would be lost at its next deployment. An empty list is accepted.',
  databases: 'Refused for now: managed databases are planned. An empty list is accepted.',
  previews: 'Refused for now, unless `enabled: false`: preview environments are planned.',
  'deploy.strategy':
    'Every deployment is `rolling`: the new replicas start, the traffic switches, then the previous ones stop. `recreate` is refused for now.',
  'deploy.keep_images': 'Refused for now: servers do not remove old images yet.',
  compose: 'Compose applications are planned: the control plane refuses them for now.',
};

/** Defaults the control plane applies to a field left out. */
const DEFAULTS = {
  'run.healthcheck.interval': '`5s`',
  'run.healthcheck.timeout': '`2s`',
  'run.healthcheck.start_period': '`0s`',
  'run.healthcheck.healthy_threshold': '`1`',
  'run.read_only_root': '`false`',
  'release.timeout': '`10m`',
  'resources.cpu': '`1`',
  'resources.memory': '`512Mi`',
  'resources.disk': '`1Gi`',
  'scale.replicas': '`1`',
  'scale.placement.spread': '`node`',
  'deploy.drain_timeout': '`30s`, at most `5m`',
};

const schema = JSON.parse(await readFile(schemaPath, 'utf8'));

/** The node a `$ref` points to, merged with the referring node's own keywords. */
function resolve(node) {
  if (!node?.$ref) return node;
  const target = node.$ref.replace('#/$defs/', '');
  const own = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
  return { ...resolve(schema.$defs[target]), ...own };
}

function code(value) {
  return `\`${typeof value === 'string' ? value : JSON.stringify(value)}\``;
}

/** "string", "integer from 1 to 10", "one of `a`, `b`"... */
function typeOf(node) {
  const n = resolve(node);
  if (n.const !== undefined) return `exactly ${code(n.const)}`;
  if (n.enum) return `one of ${n.enum.map(code).join(', ')}`;
  const types = [n.type].flat().filter(Boolean);
  if (types.includes('array')) return `list of ${typeOf(n.items ?? {})}`;
  if (types.includes('object') && n.patternProperties && !n.properties) {
    const [pattern, value] = Object.entries(n.patternProperties)[0];
    return `map of names matching ${code(pattern)} to ${typeOf(value)}`;
  }
  if (types.length === 0 && n.oneOf) return n.oneOf.map(typeOf).join(' or ');
  return types.join(' or ') || 'value';
}

/** Bounds and formats of a node, in words. */
function limits(node) {
  const n = resolve(node);
  const out = [];
  if (n.minimum !== undefined && n.maximum !== undefined)
    out.push(`from ${n.minimum} to ${n.maximum}`);
  else if (n.minimum !== undefined) out.push(`at least ${n.minimum}`);
  else if (n.maximum !== undefined) out.push(`at most ${n.maximum}`);
  if (n.pattern) out.push(`matches ${code(n.pattern)}`);
  if (n.maxLength !== undefined) out.push(`at most ${n.maxLength} characters`);
  if (n.maxItems !== undefined) out.push(`at most ${n.maxItems} items`);
  if (n.maxProperties !== undefined) out.push(`at most ${n.maxProperties} entries`);
  if (n.uniqueItems) out.push('no duplicates');
  return out;
}

/** Every field under `node`, depth first, with its dotted path. */
function fields(node, path, required, out) {
  const n = resolve(node);
  for (const [name, child] of Object.entries(n.properties ?? {})) {
    const childPath = path ? `${path}.${name}` : name;
    out.push({ path: childPath, node: child, required: required.includes(name) });
    const c = resolve(child);
    if (c.properties) fields(c, childPath, c.required ?? [], out);
    const items = c.items ? resolve(c.items) : undefined;
    if (items?.properties) fields(items, `${childPath}[]`, items.required ?? [], out);
  }
  return out;
}

/** A field: its heading (none for a top-level one, whose section heading names it), then facts. */
function entry({ path, node, required }, top) {
  const n = resolve(node);
  const lines = top ? [] : [`### \`${path}\``, ''];
  let facts = `**Type:** ${[typeOf(n), ...limits(n)].join(', ')}.`;
  if (required) facts += ' **Required.**';
  if (DEFAULTS[path]) facts += ` **Default:** ${DEFAULTS[path]}.`;
  lines.push(facts, '');
  if (n.description) lines.push(n.description, '');
  if (NOTES[path]) lines.push(`> ${NOTES[path]}`, '');
  return lines.join('\n');
}

const all = fields(schema, '', schema.required ?? [], []);
const sections = Object.keys(schema.properties).map((top) => {
  const own = all.filter(
    (f) => f.path === top || f.path.startsWith(`${top}.`) || f.path.startsWith(`${top}[]`),
  );
  return [`## \`${top}\``, '', ...own.map((field) => entry(field, field.path === top))].join('\n');
});

const page = `---
title: shipkeep.yml
description: Every field of shipkeep.yml, generated from its JSON Schema, with what the control plane does with it today.
tableOfContents:
  maxHeadingLevel: 2
---

<!-- Generated by tools/gen/config-reference.mjs from packages/config-schema/shipkeep.schema.json. Do not edit: run \`pnpm gen\`. -->

${schema.description}

The file is checked against its [JSON Schema](https://github.com/shipkeepdev/shipkeep/blob/main/packages/config-schema/shipkeep.schema.json) when it is saved, by the web UI, the CLI and the control plane. Durations are written like \`30s\`, \`10m\` or \`1m30s\`, and sizes like \`512Mi\` or \`2Gi\`.

A minimal application:

\`\`\`yaml
version: 1
name: storefront
build:
  type: image
  image: nginx:1.27
run:
  port: 80
\`\`\`

${sections.join('\n')}`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, page);

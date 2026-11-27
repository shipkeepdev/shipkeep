import { InvalidInputError } from '@shipkeep/domain';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { lineDiff, rewriteConfigFile } from './config-file';

const FILE = `# The storefront, deployed on every push to main.
version: 1
name: web # the shop

build:
  type: dockerfile # see ./Dockerfile
run:
  port: 3000
scale:
  replicas: 1 # scale later
env:
  NODE_ENV: production
domains:
  - shop.example.com
`;
const config = () =>
  parse(FILE) as Record<string, unknown> & {
    run: Record<string, unknown>;
    scale: Record<string, unknown>;
  };

describe('a shipkeep.yml changed from the interface (#214)', () => {
  it('changes only the value edited, and keeps comments, order and blank lines', () => {
    const next = config();
    next.scale.replicas = 3;
    expect(rewriteConfigFile(FILE, next)).toBe(FILE.replace('replicas: 1 #', 'replicas: 3 #'));
  });

  it('adds a key, removes one, and writes a changed list again', () => {
    const next = config();
    next.run.healthcheck = { path: '/health' };
    delete next['env'];
    next['domains'] = ['shop.example.com', 'www.shop.example.com'];
    const text = rewriteConfigFile(FILE, next);
    expect(parse(text)).toEqual(next);
    expect(text).toContain('# The storefront, deployed on every push to main.');
    expect(text).toContain('name: web # the shop');
    expect(text).not.toContain('NODE_ENV');
  });

  it('leaves a long line alone, as the file has it', () => {
    const image = `ghcr.io/acme/storefront@sha256:${'c'.repeat(64)}`;
    const file = `version: 1\nbuild:\n  image: "${image}"\nscale:\n  replicas: 1\n`;
    const next = parse(file) as { scale: Record<string, unknown> };
    next.scale['replicas'] = 2;
    expect(rewriteConfigFile(file, next)).toBe(file.replace('replicas: 1', 'replicas: 2'));
  });

  it('keeps the file’s line breaks, and its flow maps', () => {
    const file = 'version: 1\r\nrun: { port: 3000 }\r\nscale:\r\n  replicas: 1';
    const next = parse(file) as { scale: Record<string, unknown> };
    next.scale['replicas'] = 4;
    expect(rewriteConfigFile(file, next)).toBe(file.replace('replicas: 1', 'replicas: 4'));
  });

  it('changes nothing when the document is the file’s', () => {
    expect(rewriteConfigFile(FILE, config())).toBe(FILE);
  });

  it('refuses a file that is not YAML, or holds duplicate keys', () => {
    for (const broken of ['version: 1\nname: [web\n', 'version: 1\nversion: 2\n', '- a\n- b\n'])
      expect(() => rewriteConfigFile(broken, config())).toThrow(InvalidInputError);
  });
});

describe('the lines of a change', () => {
  it('shows each change with three lines around it, and counts the rest', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    expect(lineDiff(before, after)).toEqual([
      { kind: 'skipped', count: 6 },
      { kind: 'same', text: 'line 7' },
      { kind: 'same', text: 'line 8' },
      { kind: 'same', text: 'line 9' },
      { kind: 'removed', text: 'line 10' },
      { kind: 'added', text: 'line ten' },
      { kind: 'same', text: 'line 11' },
      { kind: 'same', text: 'line 12' },
      { kind: 'same', text: 'line 13' },
      { kind: 'skipped', count: 7 },
    ]);
  });

  it('keeps apart changes far from each other, and joins close ones', () => {
    const before = Array.from({ length: 30 }, (_, index) => `l${String(index)}`);
    const after = [...before];
    after[2] = 'two';
    after[25] = 'twenty-five';
    const diff = lineDiff(before.join('\n'), after.join('\n'));
    expect(diff.filter((line) => line.kind === 'skipped')).toEqual([
      { kind: 'skipped', count: 16 },
      { kind: 'skipped', count: 1 },
    ]);
    expect(diff.flatMap((line) => (line.kind === 'added' ? [line.text] : []))).toEqual([
      'two',
      'twenty-five',
    ]);
  });

  it('finds the lines kept between changes, and has nothing to show for equal texts', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nx\nc\ny\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'y' },
      { kind: 'same', text: 'd' },
    ]);
    expect(lineDiff('same\n', 'same\n')).toEqual([]);
  });

  it('stays bounded on large files: a long middle is shown removed, then added', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${String(index)}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, index) => `b${String(index)}`).join('\n');
    const diff = lineDiff(before, after);
    expect(diff.filter((line) => line.kind === 'removed')).toHaveLength(3000);
    expect(diff.filter((line) => line.kind === 'added')).toHaveLength(3000);
  });
});

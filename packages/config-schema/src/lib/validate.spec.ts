import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseShipkeepConfig, validateShipkeepConfig } from './validate.js';

const fixtures = join(import.meta.dirname, '..', '..', 'fixtures');

function list(kind: 'valid' | 'invalid'): string[] {
  return readdirSync(join(fixtures, kind))
    .filter((name) => name.endsWith('.yml'))
    .sort();
}

describe('golden fixtures', () => {
  const valid = list('valid');
  const invalid = list('invalid');

  it('has at least 20 valid and 30 invalid examples (PLAN M0.4)', () => {
    expect(valid.length).toBeGreaterThanOrEqual(20);
    expect(invalid.length).toBeGreaterThanOrEqual(30);
  });

  it.each(valid)('accepts valid/%s', (name) => {
    const result = parseShipkeepConfig(readFileSync(join(fixtures, 'valid', name), 'utf8'));
    expect(result).toMatchObject({ ok: true });
  });

  it.each(invalid)('rejects invalid/%s', (name) => {
    const result = parseShipkeepConfig(readFileSync(join(fixtures, 'invalid', name), 'utf8'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) {
        expect(issue.message).not.toHaveLength(0);
      }
    }
  });
});

describe('parseShipkeepConfig', () => {
  it('reports YAML syntax errors at the root', () => {
    const result = parseShipkeepConfig('version: 1\nname: [unclosed');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('');
  });

  it('rejects duplicate keys', () => {
    const result = parseShipkeepConfig(
      'version: 1\nname: api\nname: other\nbuild:\n  type: dockerfile\nrun:\n  port: 1\n',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects oversized documents', () => {
    const result = parseShipkeepConfig(`version: 1\nname: api\n# ${'x'.repeat(300_000)}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('bytes');
  });

  it('keeps YAML 1.1 booleans as strings', () => {
    const result = parseShipkeepConfig(
      'version: 1\nname: api\nbuild:\n  type: dockerfile\nrun:\n  port: 1\nenv:\n  FLAG: yes\n',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.env?.['FLAG']).toBe('yes');
  });
});

describe('validateShipkeepConfig', () => {
  it('names unknown keys and their location', () => {
    const result = validateShipkeepConfig({
      version: 1,
      name: 'api',
      build: { type: 'dockerfile' },
      run: { port: 3000, prot: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ path: '/run', message: 'unknown key "prot"' });
    }
  });

  it('rejects non-object documents', () => {
    expect(validateShipkeepConfig(null).ok).toBe(false);
    expect(validateShipkeepConfig('version: 1').ok).toBe(false);
    expect(validateShipkeepConfig([]).ok).toBe(false);
  });
});

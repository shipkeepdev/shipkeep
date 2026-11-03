import { inspect } from 'node:util';

import { REDACTED, Secret } from './secret.js';

const raw = 'sk_test_fake_do_not_leak_9f8e7d';

describe('Secret', () => {
  const secret = new Secret(raw);

  it('exposes the value only through expose()', () => {
    expect(secret.expose()).toBe(raw);
  });

  it.each([
    ['String()', () => String(secret)],
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- interpolation must redact
    ['template literal', () => `${secret}`],
    ['toString()', () => secret.toString()],
    ['JSON.stringify', () => JSON.stringify({ token: secret })],
    ['util.inspect', () => inspect(secret)],
    ['nested inspect', () => inspect({ creds: { token: secret } }, { depth: 5 })],
    ['Object.prototype.toString', () => Object.prototype.toString.call(secret)],
  ])('redacts through %s', (_name, render) => {
    const out = render();
    expect(out).not.toContain(raw);
    expect(out).toMatch(/REDACTED|Secret/);
  });

  it('does not expose the value as an own enumerable property', () => {
    expect(Object.keys(secret)).toEqual([]);
    expect(JSON.parse(JSON.stringify(secret))).toBe(REDACTED);
  });

  it('compares values without exposing them', () => {
    expect(secret.equals(new Secret(raw))).toBe(true);
    expect(secret.equals(new Secret('other'))).toBe(false);
    expect(secret.equals(new Secret(`${raw}x`))).toBe(false);
  });
});

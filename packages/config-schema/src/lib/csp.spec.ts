import { deepEqual, ucs2length } from './validator-runtime.js';

const VALID =
  'version: 1\nname: web\nbuild:\n  type: image\n  image: nginx:1.27\nrun:\n  port: 80\n';

/**
 * The web UI's Content-Security-Policy refuses code built from strings, and jsdom does not enforce
 * it: a runtime schema compiler left the environment page blank while every unit test passed.
 */
describe('the validator under a policy without unsafe-eval', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads and validates without building code from strings', async () => {
    vi.resetModules();
    const refuse = function (): never {
      throw new EvalError('Refused by Content-Security-Policy.');
    };
    vi.stubGlobal('Function', refuse);
    vi.stubGlobal('eval', refuse);
    const { parseShipkeepConfig } = await import('./validate.js');
    expect(parseShipkeepConfig(VALID).ok).toBe(true);
    expect(parseShipkeepConfig('version: 1\nname: "../etc"\n').ok).toBe(false);
  });
});

describe('validator runtime helpers', () => {
  it('counts code points, keeping a lone surrogate as one', () => {
    expect(ucs2length('')).toBe(0);
    expect(ucs2length('abc')).toBe(3);
    expect(ucs2length('a😀b')).toBe(3);
    expect(ucs2length('\ud83d')).toBe(1);
    expect(ucs2length('\ud83dx')).toBe(2);
  });

  it('compares JSON values deeply', () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    for (const [left, right] of [
      [1, '1'],
      [null, {}],
      [[], {}],
      [[1], [1, 2]],
      [{ a: 1 }, { a: 2 }],
      [{ a: undefined }, { b: undefined }],
      ['a', 'b'],
    ])
      expect(deepEqual(left, right)).toBe(false);
  });
});

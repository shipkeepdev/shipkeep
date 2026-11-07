import { configDiff, configYaml } from './config-diff';

describe('configYaml', () => {
  it('writes shipkeep.yml in its documented order, whatever order the database returned', () => {
    const yaml = configYaml({
      run: { port: 80 },
      name: 'web',
      build: { type: 'image' },
      version: 1,
    });
    const keys = [...yaml.matchAll(/^[a-z]+/gm)].map((match) => match[0]);
    expect(keys).toEqual(['version', 'name', 'build', 'run']);
  });
  it('keeps keys the schema does not know, after the others', () => {
    expect(configYaml({ later: 1, version: 1 }).startsWith('version')).toBe(true);
  });
  it('sees no change when only the key order differs', () => {
    expect(configDiff({ name: 'web', version: 1 }, { version: 1, name: 'web' })).toEqual([]);
  });
});

import { DEFAULT_RESOURCES } from './defaults.js';
import { validateShipkeepConfig } from './validate.js';

describe('DEFAULT_RESOURCES', () => {
  it('is one CPU and 512 MiB, written as shipkeep.yml accepts it', () => {
    expect(DEFAULT_RESOURCES).toEqual({ cpu: '1', memory: '512Mi' });
    expect(
      validateShipkeepConfig({
        version: 1,
        name: 'api',
        build: { type: 'image', image: 'nginx' },
        run: { port: 80 },
        resources: { ...DEFAULT_RESOURCES },
      }).ok,
    ).toBe(true);
  });
});

import { configSchema } from './config-schema.js';

describe('configSchema', () => {
  it('should work', () => {
    expect(configSchema()).toEqual('config-schema');
  });
});

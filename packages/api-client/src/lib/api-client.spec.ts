import { apiClient } from './api-client.js';

describe('apiClient', () => {
  it('should work', () => {
    expect(apiClient()).toEqual('api-client');
  });
});

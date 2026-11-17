import { Secret } from '@shipkeep/domain';

import {
  assertRegistryPassword,
  assertRegistryUsername,
  registryServer,
} from './registry-credential';

describe('registry server', () => {
  it('keeps a host and its port as image references name them, in lower case', () => {
    expect(registryServer('ghcr.io')).toBe('ghcr.io');
    expect(registryServer('Registry.Example.com:5000')).toBe('registry.example.com:5000');
    expect(registryServer('  quay.io ')).toBe('quay.io');
  });

  it('stores Docker Hub under one name, however it is written', () => {
    for (const name of ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'Docker.IO'])
      expect(registryServer(name)).toBe('docker.io');
  });

  it('refuses anything that is not a host: URLs, paths, credentials, spaces, traversal', () => {
    for (const name of [
      '',
      'https://ghcr.io',
      'ghcr.io/acme',
      'user:pass@ghcr.io',
      'ghcr.io:',
      'ghcr.io:0',
      'ghcr.io:70000',
      'ghcr io',
      'ghcr.io\nX-Injected: 1',
      '../etc/passwd',
      '-ghcr.io',
      'ghcr..io',
      'ghcr.io.',
      '[::1]:5000',
      `${'a'.repeat(250)}.example.com`,
      'regístry.example.com',
    ])
      expect(() => registryServer(name)).toThrow(
        expect.objectContaining({ code: 'invalid_registry_server' }),
      );
  });
});

describe('registry username and password', () => {
  it('accepts what registries issue: names, e-mail addresses and long tokens', () => {
    for (const name of ['deploy', 'robot$acme+deploy', 'owner@example.com', 'AWS', 'x'.repeat(256)])
      expect(() => {
        assertRegistryUsername(name);
      }).not.toThrow();
    for (const value of [
      'p',
      'ghp_fakeTokenForTests0123456789',
      'p@ss "w$rd\\ it\'s #1',
      'x'.repeat(4096),
    ])
      expect(() => {
        assertRegistryPassword(new Secret(value));
      }).not.toThrow();
  });

  it('refuses empty, oversized and control-character values, without echoing them', () => {
    for (const name of [
      '',
      ' ',
      'x'.repeat(257),
      'de\nploy',
      'de\u0000ploy',
      'dé ploy\u007f',
      'deploy:extra',
    ])
      expect(() => {
        assertRegistryUsername(name);
      }).toThrow(expect.objectContaining({ code: 'invalid_registry_username' }));
    for (const value of ['', 'x'.repeat(4097), 'pass\nword', 'pass\u0000word', 'é'.repeat(2049)]) {
      let thrown: unknown;
      try {
        assertRegistryPassword(new Secret(value));
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'invalid_registry_password' });
      if (value) expect(JSON.stringify(thrown)).not.toContain(value.slice(0, 8));
    }
  });
});

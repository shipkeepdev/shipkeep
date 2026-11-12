import { parseImageReference, pinnedReference } from './image-reference';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('parseImageReference', () => {
  it('follows Docker rules for the registry, repository, tag and digest', () => {
    expect(parseImageReference('nginx')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/nginx',
      name: 'nginx',
      tag: 'latest',
      digest: null,
    });
    expect(parseImageReference('acme/billing:1.4.2')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'acme/billing',
      name: 'acme/billing',
      tag: '1.4.2',
    });
    expect(parseImageReference('ghcr.io/acme/billing:1.4.2')).toMatchObject({
      registry: 'ghcr.io',
      repository: 'acme/billing',
      name: 'ghcr.io/acme/billing',
      tag: '1.4.2',
    });
    expect(parseImageReference('registry.example.com:5000/team/app')).toMatchObject({
      registry: 'registry.example.com:5000',
      repository: 'team/app',
      tag: 'latest',
    });
    expect(parseImageReference(`ghcr.io/acme/billing:1.4.2@${DIGEST}`)).toMatchObject({
      name: 'ghcr.io/acme/billing',
      tag: '1.4.2',
      digest: DIGEST,
    });
    expect(parseImageReference(`nginx@${DIGEST}`)).toMatchObject({ tag: null, digest: DIGEST });
    expect(parseImageReference('localhost/app:1')).toMatchObject({ registry: 'localhost' });
  });

  it('reads docker.io and index.docker.io as Docker Hub', () => {
    // docker.io answers the registry API with a redirect, so resolving against it fails.
    expect(parseImageReference('docker.io/traefik/whoami:v1.10.3')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'traefik/whoami',
      // What the agent pulls stays as written.
      name: 'docker.io/traefik/whoami',
      tag: 'v1.10.3',
      digest: null,
    });
    expect(parseImageReference('docker.io/nginx')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'library/nginx',
      name: 'docker.io/nginx',
    });
    expect(parseImageReference('index.docker.io/library/nginx:1.27')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'library/nginx',
    });
    // The registry host written out is not an alias: no `library/` is added for it.
    expect(parseImageReference('registry-1.docker.io/nginx')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'nginx',
      name: 'registry-1.docker.io/nginx',
    });
    // Only the exact names: a look-alike host is a registry of its own.
    expect(parseImageReference('docker.io.example.com/nginx')).toMatchObject({
      registry: 'docker.io.example.com',
      repository: 'nginx',
    });
  });

  it('rejects malformed and hostile references', () => {
    for (const bad of [
      '',
      'Nginx',
      'nginx:',
      'nginx:-bad',
      'nginx@sha256:short',
      `nginx@${DIGEST}@${DIGEST}`,
      '../etc/passwd',
      'ghcr.io/../x',
      'ghcr.io:99999/app',
      'ghcr.io:5000:1/app',
      'ghcr.io/acme/billing;rm -rf /',
      'user:pass@ghcr.io/app',
      'https://ghcr.io/app',
      'a'.repeat(513),
    ])
      expect(() => parseImageReference(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_image_reference' }),
      );
  });
});

describe('pinnedReference', () => {
  it('drops the tag and pins the digest the agent pulls', () => {
    expect(pinnedReference(parseImageReference('ghcr.io/acme/billing:1.4.2'), DIGEST)).toBe(
      `ghcr.io/acme/billing@${DIGEST}`,
    );
    expect(pinnedReference(parseImageReference('nginx'), DIGEST)).toBe(`nginx@${DIGEST}`);
    expect(() => pinnedReference(parseImageReference('nginx'), 'sha256:nope')).toThrow(
      expect.objectContaining({ code: 'invalid_image_digest' }),
    );
  });
});

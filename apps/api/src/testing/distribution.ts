import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** CNCF Distribution, the image deploy/dev/compose.yml pins (ADR 0030). */
export const DISTRIBUTION_TEST_IMAGE =
  'registry:3.1.2@sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3';

/**
 * A Distribution registry for one spec file, with token authentication: it trusts the keys of
 * `jwksFile` (read once, at start) for tokens issued by `shipkeep` for `service`.
 */
export async function distribution(
  jwksFile: string,
  service: string,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const config = [
    'version: 0.1',
    'storage:',
    '  filesystem:',
    '    rootdirectory: /var/lib/registry',
    'http:',
    '  addr: :5000',
    'auth:',
    '  token:',
    `    realm: http://${service}/api/v1/registry/token`,
    `    service: ${service}`,
    '    issuer: shipkeep',
    '    jwks: /auth/jwks.json',
    '',
  ].join('\n');
  const container: StartedTestContainer = await new GenericContainer(DISTRIBUTION_TEST_IMAGE)
    .withCopyFilesToContainer([{ source: jwksFile, target: '/auth/jwks.json' }])
    .withCopyContentToContainer([{ content: config, target: '/etc/distribution/config.yml' }])
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp('/v2/', 5000).forStatusCode(401))
    .start();
  return {
    url: `http://${container.getHost()}:${String(container.getMappedPort(5000))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

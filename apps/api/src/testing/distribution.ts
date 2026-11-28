import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import type { RegistryTokenKeyProvider } from '../modules/fleet/application/ports';
import type { RegistryStorage } from '../modules/registries/application/ports';
import { DistributionStorage } from '../modules/registries/infrastructure/distribution-storage';
import type { AppConfig } from '../platform/config/app-config';

/** CNCF Distribution, the image deploy/dev/compose.yml pins (ADR 0030). */
export const DISTRIBUTION_TEST_IMAGE =
  'registry:3.1.2@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c';

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
    '  delete:',
    '    enabled: true',
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

/** The registry at `url` as image retention reads it, with the control plane's own tokens. */
export function registryStorage(
  url: string,
  keys: RegistryTokenKeyProvider,
  service: string,
): RegistryStorage {
  return new DistributionStorage({ get: () => url } as unknown as AppConfig, keys, service);
}

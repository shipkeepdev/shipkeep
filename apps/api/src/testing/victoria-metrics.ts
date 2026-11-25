import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** VictoriaMetrics image used by integration tests, the one deploy/control-plane/compose.yml pins. */
export const VICTORIAMETRICS_TEST_IMAGE =
  'victoriametrics/victoria-metrics:v1.157.0@sha256:322a7a92fdcc269280e9c38af94c83bc76827a31b792acbc60e44394e7f29c20';

/**
 * A VictoriaMetrics for one spec file: VICTORIAMETRICS_TEST_URL where Docker is out of reach,
 * otherwise a container. Queries see the latest samples at once (-search.latencyOffset=0s).
 */
export async function victoriaMetrics(): Promise<{ url: string; stop: () => Promise<void> }> {
  const given = process.env['VICTORIAMETRICS_TEST_URL'];
  if (given) return { url: given, stop: () => Promise.resolve() };
  const container: StartedTestContainer = await new GenericContainer(VICTORIAMETRICS_TEST_IMAGE)
    .withCommand(['-search.latencyOffset=0s', '-retentionPeriod=1d'])
    .withExposedPorts(8428)
    .withWaitStrategy(Wait.forHttp('/health', 8428))
    .start();
  return {
    url: `http://${container.getHost()}:${String(container.getMappedPort(8428))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

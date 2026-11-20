import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/** VictoriaMetrics image used by integration tests, the one deploy/control-plane/compose.yml pins. */
export const VICTORIAMETRICS_TEST_IMAGE =
  'victoriametrics/victoria-metrics:v1.155.0@sha256:f60dc268b54ecf87f6e09d740c2b732838aa9193090cc741417c9f6386a130df';

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

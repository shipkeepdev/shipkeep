import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { MetricsReportSchema } from '@shipkeep/proto-ts';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { victoriaMetrics } from '../../testing/victoria-metrics';
import { PIPELINE_STORE, type PipelineStore } from '../deployments/application/ports';

import { MetricsIngest } from './application/metrics-ingest';

const CONTAINER = 'sk-charted-api-0123456789ab-r1-0';
const HIDDEN_CONTAINER = 'sk-hidden-api-0123456789ab-r1-0';

/** ADR 0024: metrics written with labels from the control plane's records, read back per tenant. */
describe('metrics with PostgreSQL and VictoriaMetrics', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let store: Awaited<ReturnType<typeof victoriaMetrics>>;
  /** What setup started, stopped in reverse order: a setup that failed half way still stops it. */
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    store = await victoriaMetrics();
    cleanups.push(() => store.stop());
    process.env['VICTORIAMETRICS_URL'] = store.url;
    cleanups.push(() => {
      Reflect.deleteProperty(process.env, 'VICTORIAMETRICS_URL');
      return Promise.resolve();
    });
    fixture = await tenantHttpFixture();
    cleanups.push(() => fixture.close());
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'metrics test cleanup failed');
  });

  const createApplication = async (
    name: string,
    domain: string,
    environment = fixture.environment,
  ) =>
    (
      (
        await fixture
          .post(`${environment}/applications`, 'owner', {
            config: {
              version: 1,
              name,
              build: { type: 'image', image: 'nginx:alpine' },
              run: { port: 80 },
              domains: [domain],
            },
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  it("writes the node's own workloads only, and reads them back for the application", async () => {
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-metrics.example.com' },
    });
    const applicationId = await createApplication('charted-api', 'charted.example.com');
    // Another application of the organization, not placed on this node.
    await createApplication('elsewhere-api', 'elsewhere.example.com');
    // An environment of the sibling project, which the environment viewer cannot read.
    const hiddenEnvironment = (
      (
        await fixture
          .post(`${fixture.root}/projects/${fixture.siblingProjectId}/environments`, 'owner', {
            name: 'hidden-metrics',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const hidden = `${fixture.root}/projects/${fixture.siblingProjectId}/environments/${hiddenEnvironment}`;
    const hiddenApplicationId = await createApplication('hidden-api', 'hidden.example.com', hidden);
    const place = async (environment: string, application: string, container: string) => {
      const queued = await fixture
        .post(`${environment}/applications/${application}/deployments`, 'owner', {})
        .expect(201);
      const releaseId = (queued.body as { release: { id: string } }).release.id;
      await fixture.app
        .get(PrismaUnitOfWork)
        .runTenant(fixture.organizationId, () =>
          fixture.app
            .get<PipelineStore>(PIPELINE_STORE)
            .place(
              fixture.organizationId,
              application,
              releaseId,
              [{ index: 0, nodeId, container, port: 80, cpuMillis: 0, memoryBytes: 0 }],
              new Date(),
            ),
        );
    };
    await place(fixture.environment, applicationId, CONTAINER);
    await place(hidden, hiddenApplicationId, HIDDEN_CONTAINER);
    const ingest = fixture.app.get(MetricsIngest);
    const identity = { organizationId: fixture.organizationId, nodeId, serial: '' };
    const now = Date.now();
    // Three samples 60 seconds apart, as an agent sends them, ending before the last grid point.
    for (const [offset, cpuSeconds, requests] of [
      [150_000, 10, 100n],
      [90_000, 40, 130n],
      [30_000, 70, 160n],
    ] as const)
      await ingest.record(
        identity,
        create(MetricsReportSchema, {
          leaseEpoch: 1n,
          sampledAt: timestampFromDate(new Date(now - offset)),
          node: { cpuSeconds: 100, cpuCores: 2, memoryUsedBytes: 1000n, memoryTotalBytes: 4000n },
          containers: [
            { name: CONTAINER, cpuSeconds, memoryUsedBytes: 5_000_000n },
            { name: HIDDEN_CONTAINER, cpuSeconds, memoryUsedBytes: 1_000_000n },
            { name: 'sk-not-placed-here-r1-0', cpuSeconds: 999 },
          ],
          hosts: [
            { host: 'charted.example.com', responses2xx: requests, durationSeconds: 1 },
            // Only the hidden environment answers 4xx: whoever sees 4xx traffic sees it.
            { host: 'hidden.example.com', responses4xx: requests },
            { host: 'elsewhere.example.com', responses2xx: 999n },
          ],
        }),
        new Date(now - offset),
      );
    await fetch(new URL('/internal/force_flush', store.url));

    const answer = (
      await fixture
        .get(
          `${fixture.environment}/applications/${applicationId}/metrics?range=1h`,
          'environmentViewer',
        )
        .expect(200)
    ).body as {
      kept: boolean;
      cpu: { points: { v: number }[] }[];
      memory: { points: { v: number }[] }[];
      requests: { labels: { status: string }; points: { v: number }[] }[];
    };
    expect(answer.kept).toBe(true);
    // 30 CPU seconds in 60 seconds: half a core.
    expect(answer.cpu[0]?.points.at(-1)?.v).toBeCloseTo(0.5, 1);
    expect(answer.memory[0]?.points.at(-1)?.v).toBe(5_000_000);
    expect(answer.requests.map((series) => series.labels.status)).toContain('2xx');

    // Nothing was written for the container or the domain this node does not run.
    const match = encodeURIComponent(`{organization_id="${fixture.organizationId}"}`);
    const series = (await (
      await fetch(new URL(`/api/v1/series?match[]=${match}`, store.url))
    ).json()) as { data: Record<string, string>[] };
    const domains = new Set(series.data.map((labels) => labels['domain']).filter(Boolean));
    expect([...domains].sort()).toEqual(['charted.example.com', 'hidden.example.com']);
    const replicas = series.data.filter((labels) =>
      labels['__name__'].startsWith('shipkeep_container_'),
    );
    expect(new Set(replicas.map((labels) => labels['application_id']))).toEqual(
      new Set([applicationId, hiddenApplicationId]),
    );

    // A server's charts need node.manage. Without it the server is not even there: 404, as for every
    // tenant route.
    await fixture
      .get(`/api/v1/organizations/${fixture.organizationId}/nodes/${nodeId}/metrics`, 'owner')
      .expect(200);
    await fixture
      .get(
        `/api/v1/organizations/${fixture.organizationId}/nodes/${nodeId}/metrics`,
        'environmentViewer',
      )
      .expect(404);

    // The organization's requests: every environment for an owner, the readable ones for a member,
    // nothing for a member who reads none, and no organization at all for an outsider. Only the
    // hidden environment has 4xx traffic, so a viewer who saw any would see that environment.
    // 1 h: its 30-second steps see the samples just written, as for the application above.
    const organization = `/api/v1/organizations/${fixture.organizationId}/metrics?range=1h`;
    const requests = async (actor: 'owner' | 'environmentViewer' | 'member') =>
      (
        (await fixture.get(organization, actor).expect(200)).body as {
          requests: { labels: { status: string }; points: { v: number }[] }[];
        }
      ).requests;
    const traffic = (series: Awaited<ReturnType<typeof requests>>, status: string) =>
      series
        .filter((item) => item.labels.status === status)
        .flatMap((item) => item.points.map((point) => point.v))
        .reduce((sum, value) => sum + value, 0);
    const owner = await requests('owner');
    expect(traffic(owner, '2xx')).toBeGreaterThan(0);
    expect(traffic(owner, '4xx')).toBeGreaterThan(0);
    const viewer = await requests('environmentViewer');
    expect(traffic(viewer, '2xx')).toBeGreaterThan(0);
    expect(traffic(viewer, '4xx')).toBe(0);
    expect(await requests('member')).toEqual([]);
    // Totals over the whole period include the latest samples: 60 requests each for the two
    // environments the owner reads (100 to 160), only those of the readable one for the viewer.
    const totals = async (actor: 'owner' | 'environmentViewer' | 'member') =>
      (await fixture.get(organization, actor).expect(200)).body as {
        totalRequests: number;
        meanSeconds: number | null;
      };
    const ownerTotals = await totals('owner');
    const viewerTotals = await totals('environmentViewer');
    expect(ownerTotals.totalRequests).toBeGreaterThan(viewerTotals.totalRequests);
    expect(viewerTotals.totalRequests).toBeGreaterThan(0);
    expect(viewerTotals.meanSeconds).not.toBeNull();
    expect(await totals('member')).toMatchObject({ totalRequests: 0, meanSeconds: null });
    await fixture.get(organization, 'outsider').expect(404);
  });
});

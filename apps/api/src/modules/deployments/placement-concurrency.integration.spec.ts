import { Client } from 'pg';

import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';
import { PIPELINE_STORE, type PipelineStore } from './application/ports';

/** Issue #315: deployments placed at the same moment must not take the same room. */
describe('concurrent placements with PostgreSQL', () => {
  const APPLICATIONS = 4;
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    // One CPU: room for exactly one application that declares no `resources`.
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-one-cpu.example.com',
        architecture: 'amd64',
        cpu_count: 1,
        memory_bytes: 2 ** 33,
      },
    });
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('places one of several deployments that start together, and refuses the others', async () => {
    const deploymentIds: string[] = [];
    for (let index = 0; index < APPLICATIONS; index++) {
      const application = await fixture
        .post(`${fixture.environment}/applications`, 'owner', {
          config: {
            version: 1,
            name: `racer-${String(index)}`,
            // Already pinned: no registry request in tests.
            build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
            run: { port: 3000 },
          },
        })
        .expect(201);
      const queued = await fixture
        .post(
          `${fixture.environment}/applications/${(application.body as { id: string }).id}/deployments`,
          'owner',
          {},
        )
        .expect(201);
      deploymentIds.push((queued.body as { deployment: { id: string } }).deployment.id);
    }

    // Each placement pauses after it has read the load, so that the reads overlap every time
    // unless something serializes them: the test does not depend on timing.
    const store = fixture.app.get<PipelineStore>(PIPELINE_STORE);
    const load = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation(async (...parameters) => {
      const loads = await load(...parameters);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return loads;
    });

    const pipeline = fixture.app.get(DeploymentPipeline);
    await Promise.all(deploymentIds.map((id) => pipeline.run(fixture.organizationId, id)));

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const reserved = await admin.query<{ replicas: string; cpu: string }>(
        "SELECT count(*) AS replicas, coalesce(sum(cpu_millis), 0) AS cpu FROM allocations WHERE node_id = $1 AND state = 'placed'",
        [nodeId],
      );
      // Unserialized, every run reads the load before any of them stores its replica.
      expect(reserved.rows).toEqual([{ replicas: '1', cpu: '1000' }]);
      const deployments = await admin.query<{ state: string; error: string | null }>(
        'SELECT state, error FROM deployments WHERE id = ANY($1::uuid[]) ORDER BY state',
        [deploymentIds],
      );
      const failed = deployments.rows.filter((row) => row.state === 'failed');
      expect(failed).toHaveLength(APPLICATIONS - 1);
      for (const row of failed)
        expect(row.error).toBe('No node can run replica 1 of 1 (edge-one-cpu: cpu).');
      expect(deployments.rows.filter((row) => row.state === 'starting')).toHaveLength(1);
    } finally {
      await admin.end();
    }
  });
});

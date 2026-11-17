import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';

interface DeploymentBody {
  id: string;
  state: string;
  releaseId: string;
  build: boolean;
  release: boolean;
  stop: boolean;
  trigger: string;
}

/** Issue #256: stopping an application over HTTP, with the real pipeline and PostgreSQL. */
describe('stopping an application over HTTP', () => {
  // The node's heartbeat and the pipeline's clock: the node stays ready however long this takes.
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-stop.example.com',
        architecture: 'amd64',
        cpu_count: 1,
        memory_bytes: 2 ** 32,
      },
      heartbeatAt: NOW,
    });
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  /** Runs the pipeline, letting the agents succeed at every action it queues. */
  async function runToTheEnd(deploymentId: string): Promise<void> {
    const pipeline = fixture.app.get(DeploymentPipeline);
    for (let round = 0; round < 10; round++) {
      if ((await pipeline.run(fixture.organizationId, deploymentId, () => NOW)) === 'done') return;
      await admin.query(
        `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE deployment_id = $1 AND state = 'queued'`,
        [deploymentId],
      );
    }
    throw new Error('the deployment did not finish');
  }
  const reserved = async () =>
    (
      await admin.query<{ cpu: string }>(
        "SELECT coalesce(sum(cpu_millis), 0) AS cpu FROM allocations WHERE node_id = $1 AND state = 'placed'",
        [nodeId],
      )
    ).rows[0]?.cpu;

  it('removes the replicas, frees their room and keeps the application', async () => {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'stoppable-api',
          // Already pinned: no registry request in tests.
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
          domains: ['stoppable.example.com'],
        },
      })
      .expect(201);
    const applicationId = (created.body as { id: string }).id;
    const application = `${fixture.environment}/applications/${applicationId}`;

    // Nothing runs yet.
    await fixture
      .post(`${application}/stop`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_not_running' });
      });

    const first = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
      .body as { deployment: DeploymentBody };
    expect(
      await fixture.app
        .get(DeploymentPipeline)
        .run(fixture.organizationId, first.deployment.id, () => NOW),
    ).toBe('wait');
    expect(await reserved()).toBe('1000');
    // Its replica is placed, but the deployment still runs.
    await fixture
      .post(`${application}/stop`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
      });
    // It succeeded just before the fixed test clock, which stamps what the pipeline does next.
    await admin.query(
      "UPDATE deployments SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
      [first.deployment.id, new Date(NOW.getTime() - 1000)],
    );

    // Stopping needs the right to deploy.
    for (const actor of ['environmentDeveloper', 'environmentViewer', 'outsider'] as const)
      await fixture.post(`${application}/stop`, actor, {}).expect(404);
    const stopping = (await fixture.post(`${application}/stop`, 'environmentAdmin', {}).expect(201))
      .body as DeploymentBody;
    expect(stopping).toMatchObject({
      state: 'queued',
      releaseId: first.deployment.releaseId,
      trigger: 'manual',
      build: false,
      release: false,
      stop: true,
    });
    await fixture
      .post(`${application}/deployments`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
      });

    await runToTheEnd(stopping.id);
    const state = await admin.query<{ state: string; error: string | null }>(
      'SELECT state, error FROM deployments WHERE id = $1',
      [stopping.id],
    );
    expect(state.rows).toEqual([{ state: 'succeeded', error: null }]);
    const actions = await admin.query<{ kind: string }>(
      'SELECT kind FROM agent_actions WHERE deployment_id = $1 ORDER BY id',
      [stopping.id],
    );
    expect(actions.rows.map((row) => row.kind)).toEqual([
      'removeRoute',
      'stopContainer',
      'removeContainer',
    ]);
    // The reservation is gone, and the application is not.
    expect(await reserved()).toBe('0');
    const replicas = await fixture.get(`${application}/replicas`, 'owner').expect(200);
    expect((replicas.body as { items: unknown[] }).items).toEqual([]);
    await fixture.get(application, 'owner').expect(200);
    // The pipeline stamps its events with the fixed test clock, so only the set is compared.
    const events = await auditLog().findMany({ where: { targetId: stopping.id } });
    expect(events.map((event) => event.action).sort()).toEqual([
      'deployment.advanced',
      'deployment.advanced',
      'deployment.queued',
    ]);
    expect(events.find((event) => event.action === 'deployment.queued')?.metadata).toMatchObject({
      plan: 'stop',
      applicationId,
    });

    // Stopped twice is refused, and the version that ran can be started again.
    await fixture
      .post(`${application}/stop`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_not_running' });
      });
    const again = (
      await fixture
        .post(`${application}/deployments/${first.deployment.id}/rollback`, 'owner', {})
        .expect(201)
    ).body as { deployment: DeploymentBody };
    expect(again.deployment).toMatchObject({ state: 'queued', trigger: 'rollback', stop: false });
  });
});

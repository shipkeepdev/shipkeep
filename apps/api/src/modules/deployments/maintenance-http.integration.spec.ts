import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';

interface DeploymentBody {
  id: string;
  state: string;
  releaseId: string;
  stop: boolean;
  maintenance: 'enter' | 'leave' | null;
  trigger: string;
}

/** Issue #256, ADR 0025: maintenance over HTTP, with the real pipeline and PostgreSQL. */
describe('maintenance over HTTP', () => {
  // The node's heartbeat and the pipeline's clock: the node stays ready however long this takes.
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-maintenance.example.com',
        architecture: 'amd64',
        cpu_count: 4,
        memory_bytes: 2 ** 34,
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

  /** An application with one placed replica whose deployment succeeded. */
  async function running(name: string, domains: string[]): Promise<string> {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name,
          // Already pinned: no registry request in tests.
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
          ...(domains.length ? { domains } : {}),
        },
      })
      .expect(201);
    const application = `${fixture.environment}/applications/${(created.body as { id: string }).id}`;
    await fixture
      .post(`${application}/maintenance/enter`, 'owner', {})
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
    // It succeeded just before the fixed test clock, which stamps what the pipeline does next.
    await admin.query(
      "UPDATE deployments SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
      [first.deployment.id, new Date(NOW.getTime() - 1000)],
    );
    return application;
  }
  const kinds = async (deploymentId: string) =>
    (
      await admin.query<{ kind: string }>(
        'SELECT kind FROM agent_actions WHERE deployment_id = $1 ORDER BY id',
        [deploymentId],
      )
    ).rows.map((row) => row.kind);
  const replicas = async (application: string) =>
    (
      (await fixture.get(`${application}/replicas`, 'owner').expect(200)).body as {
        items: unknown[];
      }
    ).items.length;
  const refused = (code: string) => (response: { body: unknown }) => {
    expect(response.body).toMatchObject({ code });
  };

  it('puts the page on the routes, keeps the replicas, and holds deployments until it ends', async () => {
    const application = await running('maintained-api', ['maintained.example.com']);
    await fixture
      .post(`${application}/maintenance/leave`, 'owner', {})
      .expect(409)
      .expect(refused('maintenance_not_on'));

    // Entering needs the right to deploy.
    for (const actor of ['environmentDeveloper', 'environmentViewer', 'outsider'] as const)
      await fixture.post(`${application}/maintenance/enter`, actor, {}).expect(404);
    const entering = (
      await fixture.post(`${application}/maintenance/enter`, 'environmentAdmin', {}).expect(201)
    ).body as DeploymentBody;
    expect(entering).toMatchObject({
      state: 'queued',
      trigger: 'manual',
      stop: false,
      maintenance: 'enter',
    });
    await fixture
      .post(`${application}/deployments`, 'owner', {})
      .expect(409)
      .expect(refused('deployment_in_progress'));

    await runToTheEnd(entering.id);
    const state = await admin.query<{ state: string; error: string | null }>(
      'SELECT state, error FROM deployments WHERE id = $1',
      [entering.id],
    );
    expect(state.rows).toEqual([{ state: 'succeeded', error: null }]);
    // Only the route changed: nothing was pulled, started or stopped, and the replica stays.
    expect(await kinds(entering.id)).toEqual(['upsertRoute']);
    expect(await replicas(application)).toBe(1);
    const events = await auditLog().findMany({ where: { targetId: entering.id } });
    expect(events.map((event) => event.action).sort()).toEqual([
      'deployment.advanced',
      'deployment.advanced',
      'deployment.queued',
    ]);
    expect(events.find((event) => event.action === 'deployment.queued')?.metadata).toMatchObject({
      plan: 'maintenance_enter',
    });

    // In maintenance: no new release starts behind the page, and entering twice is refused.
    await fixture
      .post(`${application}/deployments`, 'owner', {})
      .expect(409)
      .expect(refused('application_in_maintenance'));
    const history = (await fixture.get(`${application}/deployments`, 'owner').expect(200)).body as {
      items: DeploymentBody[];
    };
    const original = history.items.find((item) => item.maintenance === null);
    await fixture
      .post(`${application}/deployments/${String(original?.id)}/rollback`, 'owner', {})
      .expect(409)
      .expect(refused('application_in_maintenance'));
    await fixture
      .post(`${application}/maintenance/enter`, 'owner', {})
      .expect(409)
      .expect(refused('maintenance_already_on'));

    const leaving = (
      await fixture.post(`${application}/maintenance/leave`, 'owner', {}).expect(201)
    ).body as DeploymentBody;
    expect(leaving).toMatchObject({ maintenance: 'leave', releaseId: entering.releaseId });
    await runToTheEnd(leaving.id);
    expect(await kinds(leaving.id)).toEqual(['upsertRoute']);
    expect(await replicas(application)).toBe(1);
    // Out of maintenance, deploying works again.
    await fixture.post(`${application}/deployments`, 'owner', {}).expect(201);
  });

  it('keeps the replicas running and serving when entering fails', async () => {
    const application = await running('interrupted-api', ['interrupted.example.com']);
    const entering = (
      await fixture.post(`${application}/maintenance/enter`, 'owner', {}).expect(201)
    ).body as DeploymentBody;
    const pipeline = fixture.app.get(DeploymentPipeline);
    expect(await pipeline.run(fixture.organizationId, entering.id, () => NOW)).toBe('wait');
    // The agent refuses the route: the deployment fails while it switches.
    await admin.query(
      `UPDATE agent_actions SET state = 'failed', completed_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND state = 'queued'`,
      [entering.id],
    );
    expect(await pipeline.run(fixture.organizationId, entering.id, () => NOW)).toBe('done');
    const state = await admin.query<{ state: string }>(
      'SELECT state FROM deployments WHERE id = $1',
      [entering.id],
    );
    expect(state.rows).toEqual([{ state: 'failed' }]);
    // The recovery puts the replicas back on the route, and they keep their reservation.
    expect(await kinds(entering.id)).toEqual(['upsertRoute', 'upsertRoute']);
    expect(await replicas(application)).toBe(1);
    await fixture
      .post(`${application}/maintenance/leave`, 'owner', {})
      .expect(409)
      .expect(refused('maintenance_not_on'));
  });

  it('ends with a stop, and is refused without a domain or with an older agent', async () => {
    const application = await running('stopped-in-maintenance', ['paused.example.com']);
    // An agent released before the page would refuse its route: entering is refused first.
    await admin.query(
      `UPDATE nodes SET facts = jsonb_set(facts, '{agent_version}', '"0.1.0-alpha.3"') WHERE id = $1`,
      [nodeId],
    );
    await fixture
      .post(`${application}/maintenance/enter`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'agent_outdated',
          details: { servers: [expect.any(String)] },
        });
      });
    await admin.query(
      `UPDATE nodes SET facts = jsonb_set(facts, '{agent_version}', '"0.1.0"') WHERE id = $1`,
      [nodeId],
    );

    const entering = (
      await fixture.post(`${application}/maintenance/enter`, 'owner', {}).expect(201)
    ).body as DeploymentBody;
    await runToTheEnd(entering.id);
    // A stop is allowed in maintenance, and ends it with the replicas.
    const stopping = (await fixture.post(`${application}/stop`, 'owner', {}).expect(201))
      .body as DeploymentBody;
    await runToTheEnd(stopping.id);
    expect(await replicas(application)).toBe(0);
    await fixture
      .post(`${application}/maintenance/leave`, 'owner', {})
      .expect(409)
      .expect(refused('maintenance_not_on'));

    // Without a domain there is no route to put the page on.
    const hidden = await running('without-domain', []);
    await fixture
      .post(`${hidden}/maintenance/enter`, 'owner', {})
      .expect(409)
      .expect(refused('application_without_domain'));
  });
});

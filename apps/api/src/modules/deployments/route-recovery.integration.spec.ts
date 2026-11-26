import { Client } from 'pg';

import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AgentActions } from '../fleet/application/agent-actions';

import { DeploymentPipeline } from './application/deployment-pipeline';
import { containerName } from './domain/container-plan';

/**
 * Issue #485: a deployment that changes `domains` and fails during its route switch puts the
 * previous route back as it was, hostnames included, with the real pipeline and PostgreSQL.
 */
describe('route recovery with PostgreSQL', () => {
  // The node's heartbeat and the pipeline's clock: the node stays ready however long this takes.
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-recovery.example.com',
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

  /**
   * Runs the pipeline to its end. The agents succeed at every action, except this deployment's
   * route switch (`route`) or the stops that drain the replicas it replaces (`stop`).
   */
  async function run(deploymentId: string, refuse?: 'route' | 'stop'): Promise<void> {
    const pipeline = fixture.app.get(DeploymentPipeline);
    for (let round = 0; round < 12; round++) {
      if ((await pipeline.run(fixture.organizationId, deploymentId, () => NOW)) === 'done') return;
      if (refuse)
        await admin.query(
          `UPDATE agent_actions SET state = 'failed', error = 'action failed', completed_at = now(), updated_at = now()
           WHERE deployment_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
          [deploymentId, `d:${deploymentId}:${refuse}:%`],
        );
      // What an agent reports: a container id for a create, a healthy probe.
      await admin.query(
        `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now(),
           result = CASE kind
             WHEN 'createContainer' THEN jsonb_build_object('containerId', md5(idempotency_key))
             WHEN 'healthCheck' THEN '{"healthCheck": {"healthy": true}}'::jsonb
             ELSE result END
         WHERE deployment_id = $1 AND state = 'queued' AND idempotency_key NOT LIKE $2`,
        [deploymentId, `d:${deploymentId}:restore:%`],
      );
    }
    throw new Error('the deployment did not finish');
  }

  async function deploy(application: string): Promise<string> {
    const queued = await fixture.post(`${application}/deployments`, 'owner', {}).expect(201);
    return (queued.body as { deployment: { id: string } }).deployment.id;
  }

  it('restores the previous hostnames and replica when a domain change fails to switch', async () => {
    const config = (domains: string[]) => ({
      version: 1,
      name: 'renamed-api',
      // Already pinned: no registry request in tests.
      build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
      run: { port: 3000 },
      domains,
    });
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: config(['old-485.example.com']),
      })
      .expect(201);
    const app = created.body as { id: string; name: string; configSha: string };
    const application = `${fixture.environment}/applications/${app.id}`;
    await run(await deploy(application));

    // Release 2 moves the application to another hostname; the agent refuses the new route.
    await fixture
      .post(`${application}/config`, 'owner', {
        expectedConfigSha: app.configSha,
        config: config(['new-485.example.com']),
      })
      .expect(200);
    const second = await deploy(application);
    await run(second, 'route');
    const state = await admin.query<{ state: string }>(
      'SELECT state FROM deployments WHERE id = $1',
      [second],
    );
    expect(state.rows).toEqual([{ state: 'failed' }]);

    const requests = await fixture.app
      .get(AgentActions)
      .deliverable({ organizationId: fixture.organizationId, nodeId, serial: '' }, new Set(), NOW);
    const restored = requests.filter((request) =>
      request.idempotencyKey.startsWith(`d:${second}:restore:`),
    );
    expect(restored).toHaveLength(1);
    const [{ action }] = restored;
    expect(action.case).toBe('upsertRoute');
    if (action.case !== 'upsertRoute') return;
    // The previous release's hostname and replica: the new hostname is not attached to it.
    expect(action.value.route?.hosts).toEqual(['old-485.example.com']);
    const previous = containerName(app, 1, 0);
    expect(
      action.value.route?.upstreams.map(
        (upstream) => `${upstream.container}:${String(upstream.port)}`,
      ),
    ).toEqual([`${previous}:3000`]);
  });

  // The route serves the release of the latest switch that completed, which the newest placed
  // release is: a rollback is a new release, and a release that failed before draining is stopped.
  it('restores the hostnames of a rollback whose draining failed, not those of the release it replaced', async () => {
    const config = (domains: string[]) => ({
      version: 1,
      name: 'rolled-api',
      build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'d'.repeat(64)}` },
      run: { port: 3000 },
      domains,
    });
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: config(['a-485.example.com']),
      })
      .expect(201);
    const app = created.body as { id: string; name: string; configSha: string };
    const application = `${fixture.environment}/applications/${app.id}`;
    const first = await deploy(application);
    await run(first);
    await fixture
      .post(`${application}/config`, 'owner', {
        expectedConfigSha: app.configSha,
        config: config(['b-485.example.com']),
      })
      .expect(200);
    await run(await deploy(application));
    // Back to release 1's configuration, as release 3: its switch completes, its draining fails,
    // so release 2 keeps its replicas while release 3 serves a-485.
    const rollback = await fixture
      .post(`${application}/deployments/${first}/rollback`, 'owner', {})
      .expect(201);
    const rolledBack = rollback.body as { deployment: { id: string }; release: { number: number } };
    expect(rolledBack.release.number).toBe(3);
    await run(rolledBack.deployment.id, 'stop');
    const placed = await admin.query<{ number: number }>(
      `SELECT DISTINCT r.number FROM allocations a JOIN releases r ON r.id = a.release_id
       WHERE a.application_id = $1 AND a.state = 'placed' ORDER BY r.number`,
      [app.id],
    );
    expect(placed.rows.map((row) => row.number)).toEqual([2, 3]);

    const current = (await fixture.get(application, 'owner').expect(200)).body as {
      configSha: string;
    };
    await fixture
      .post(`${application}/config`, 'owner', {
        expectedConfigSha: current.configSha,
        config: config(['c-485.example.com']),
      })
      .expect(200);
    const fourth = await deploy(application);
    await run(fourth, 'route');
    const requests = await fixture.app
      .get(AgentActions)
      .deliverable({ organizationId: fixture.organizationId, nodeId, serial: '' }, new Set(), NOW);
    const restored = requests.filter((request) =>
      request.idempotencyKey.startsWith(`d:${fourth}:restore:`),
    );
    expect(restored).toHaveLength(1);
    const [{ action }] = restored;
    if (action.case !== 'upsertRoute') throw new Error(`unexpected ${String(action.case)}`);
    expect(action.value.route?.hosts).toEqual(['a-485.example.com']);
  });
});

import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';
import { DeploymentWorker } from './infrastructure/deployment-worker';

/** PLAN M3.4c4c: a queued deployment gets its pipeline job and starts on a ready node. */
describe('deployment pipeline with PostgreSQL and pg-boss', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-run.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
    });
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('commits the run with the deployment and enqueues the first agent actions', async () => {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'pinned-api',
          // Already pinned: no registry request in tests.
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const jobs = await admin.query<{ singleton_key: string; data: unknown }>(
        "SELECT singleton_key, data FROM shipkeep_jobs.job WHERE name = 'deployment-run'",
      );
      expect(jobs.rows).toEqual([
        {
          singleton_key: deploymentId,
          data: { organizationId: fixture.organizationId, deploymentId },
        },
      ]);

      expect(
        await fixture.app.get(DeploymentPipeline).run(fixture.organizationId, deploymentId),
      ).toBe('wait');
      const state = await admin.query<{ state: string }>(
        'SELECT state FROM deployments WHERE id = $1',
        [deploymentId],
      );
      expect(state.rows[0]?.state).toBe('starting');
      const actions = await admin.query<{
        idempotency_key: string;
        kind: string;
        application_id: string;
        deployment_id: string;
      }>(
        'SELECT idempotency_key, kind, application_id, deployment_id FROM agent_actions WHERE node_id = $1',
        [nodeId],
      );
      expect(actions.rows).toEqual([
        {
          idempotency_key: `d:${deploymentId}:net:${nodeId}`,
          kind: 'ensureNetwork',
          // The action names the deployment that needs it (issue #263).
          application_id: applicationId,
          deployment_id: deploymentId,
        },
      ]);
      const placed = await admin.query<{
        replica: number;
        cpu_millis: number;
        memory_bytes: string;
      }>('SELECT replica, cpu_millis, memory_bytes FROM allocations WHERE node_id = $1', [nodeId]);
      // No `resources` in the configuration: the replica reserves the default limits (#301).
      expect(placed.rows).toEqual([{ replica: 0, cpu_millis: 1000, memory_bytes: '536870912' }]);
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({
      where: { targetId: deploymentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toEqual([
      'deployment.queued',
      'deployment.advanced',
      'deployment.placed',
      'deployment.advanced',
    ]);
  });

  it('links an action only to a deployment of its own application', async () => {
    const other = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'other-api',
          build: { type: 'image', image: `ghcr.io/acme/other@sha256:${'d'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const otherId = (other.body as { id: string }).id;
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ id: string }>(
        'SELECT id FROM agent_actions WHERE deployment_id IS NOT NULL LIMIT 1',
      );
      const id = rows[0]?.id;
      await expect(
        admin.query('UPDATE agent_actions SET application_id = $2 WHERE id = $1', [id, otherId]),
      ).rejects.toThrow(/agent_actions_deployment_fkey/);
      await expect(
        admin.query('UPDATE agent_actions SET deployment_id = NULL WHERE id = $1', [id]),
      ).rejects.toThrow(/agent_actions_origin_check/);

      // Deleting the application keeps the node's history and clears only the link.
      await admin.query(
        'DELETE FROM applications WHERE id = (SELECT application_id FROM agent_actions WHERE id = $1)',
        [id],
      );
      const kept = await admin.query(
        'SELECT node_id, application_id, deployment_id FROM agent_actions WHERE id = $1',
        [id],
      );
      expect(kept.rows).toEqual([{ node_id: nodeId, application_id: null, deployment_id: null }]);
    } finally {
      await admin.end();
    }
  });

  it('fails a deployment whose release cannot be planned, and frees the application', async () => {
    const config = {
      version: 1,
      name: 'unplannable-api',
      build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
      run: { port: 3000 },
    };
    // Sixteen digits pass the schema and overflow the planner. Saving them is refused now...
    const refused = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: { ...config, resources: { cpu: '9999999999999999' } },
      })
      .expect(400);
    expect(refused.body).toMatchObject({
      code: 'invalid_application_config',
      details: { issues: [{ path: '/resources/cpu', message: 'must be at most 256 CPUs' }] },
    });
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', { config })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const deployments = `${fixture.environment}/applications/${applicationId}/deployments`;
    const queued = await fixture.post(deployments, 'owner', {}).expect(201);
    const { deployment, release } = queued.body as {
      deployment: { id: string };
      release: { id: string };
    };
    const deploymentId = deployment.id;
    // ...but a release stored before that check may still hold such a value (issue #314).
    const owner = new Client({ connectionString: fixture.databaseUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE releases DISABLE TRIGGER releases_write_once');
      await owner.query(
        `UPDATE releases SET config = jsonb_set(config, '{resources}', '{"cpu":"9999999999999999"}')
         WHERE id = $1`,
        [release.id],
      );
      await owner.query('ALTER TABLE releases ENABLE TRIGGER releases_write_once');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }

    // The run used to throw, which only retried the job and left the deployment queued.
    expect(
      await fixture.app.get(DeploymentPipeline).run(fixture.organizationId, deploymentId),
    ).toBe('done');
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const state = await admin.query<{ state: string; error: string }>(
        'SELECT state, error FROM deployments WHERE id = $1',
        [deploymentId],
      );
      expect(state.rows).toEqual([{ state: 'failed', error: 'The cpu value is invalid.' }]);
      const placed = await admin.query('SELECT 1 FROM allocations WHERE application_id = $1', [
        applicationId,
      ]);
      expect(placed.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({
      where: { targetId: deploymentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.at(-1)?.action).toBe('deployment.failed');
    // The application's single active deployment is released: another one can be queued.
    await fixture.post(deployments, 'owner', {}).expect(201);
  });

  // Issue #486: pg-boss gave up on a deployment's run; the sweep queues it again, once.
  it('wakes a deployment whose last run failed for good', async () => {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'stranded-api',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const jobs = async () =>
      (
        await admin.query<{ state: string }>(
          "SELECT state FROM shipkeep_jobs.job WHERE name = 'deployment-run' AND singleton_key = $1 ORDER BY created_on",
          [deploymentId],
        )
      ).rows.map((row) => row.state);
    const issued = async () =>
      (
        await admin.query<{ idempotency_key: string }>(
          'SELECT idempotency_key FROM agent_actions WHERE deployment_id = $1 ORDER BY id',
          [deploymentId],
        )
      ).rows.map((row) => row.idempotency_key);
    try {
      // A first run issued an agent action, then the job ran out of retries.
      const pipeline = fixture.app.get(DeploymentPipeline);
      expect(await pipeline.run(fixture.organizationId, deploymentId)).toBe('wait');
      const before = await issued();
      expect(before).toHaveLength(1);
      await admin.query(
        "UPDATE shipkeep_jobs.job SET state = 'failed', completed_on = now() WHERE name = 'deployment-run' AND singleton_key = $1",
        [deploymentId],
      );
      expect(await jobs()).toEqual(['failed']);
      const worker = fixture.app.get(DeploymentWorker);
      expect(await worker.sweep()).toBeGreaterThanOrEqual(1);
      expect(await jobs()).toEqual(['failed', 'created']);
      // Its latest job is queued now: a second sweep adds nothing.
      await worker.sweep();
      expect(await jobs()).toEqual(['failed', 'created']);
      // The run that resumes it issues nothing twice.
      expect(await pipeline.run(fixture.organizationId, deploymentId)).toBe('wait');
      expect(await issued()).toEqual(before);
    } finally {
      await admin.end();
    }
  });

  it('places on the ready node when another node has reported no capacity', async () => {
    await enrollTestNode(fixture, { name: 'edge-silent', facts: {} });
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'placed-api',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;

    // One node without facts used to make placement throw for the whole organization.
    expect(
      await fixture.app.get(DeploymentPipeline).run(fixture.organizationId, deploymentId),
    ).toBe('wait');
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const placed = await admin.query<{ node_id: string }>(
        'SELECT node_id FROM allocations WHERE application_id = $1',
        [applicationId],
      );
      expect(placed.rows).toEqual([{ node_id: nodeId }]);
    } finally {
      await admin.end();
    }
  });
});

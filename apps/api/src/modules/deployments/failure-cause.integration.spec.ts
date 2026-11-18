import { Client } from 'pg';

import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';

const DIGEST = `sha256:${'c'.repeat(64)}`;
/** What a compromised or broken agent could send instead of a fixed text. */
const HOSTILE = 'pull failed: https://deploy:sk_test_fake_registry_password@registry.example.com';

/** Issue #265: a deployment that fails at the pull says why, from the action's reason. */
describe('the cause of a failed pull, with PostgreSQL', () => {
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  /** Set last in the setup: undefined when an earlier step of it failed. */
  let connection: Client | undefined;
  const admin = (): Client => {
    if (!connection) throw new Error('the setup did not finish');
    return connection;
  };

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-cause.example.com',
        architecture: 'amd64',
        cpu_count: 16,
        memory_bytes: 2 ** 35,
      },
      heartbeatAt: NOW,
    });
    const client = new Client({ connectionString: fixture.databaseUrl });
    await client.connect();
    connection = client;
  });
  afterAll(async () => {
    // The fixture is closed whatever happened to the connection, or to the rest of the setup.
    try {
      await connection?.end();
    } finally {
      await fixture.close();
    }
  });

  /** Deploys an image and lets the agent end the pull as given; returns what the API then shows. */
  async function failedAtThePull(name: string, state: string, error: string | null) {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name,
          // Already pinned: the test asks no registry.
          build: { type: 'image', image: `ghcr.io/acme/${name}@${DIGEST}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;
    const pipeline = fixture.app.get(DeploymentPipeline);
    for (let round = 0; round < 10; round++) {
      if ((await pipeline.run(fixture.organizationId, deploymentId, () => NOW)) === 'done') break;
      // The agent reports: the pull as the test says, everything else as done.
      await admin().query(
        `UPDATE agent_actions SET state = $2, error = $3, completed_at = now(), updated_at = now()
         WHERE deployment_id = $1 AND state = 'queued' AND kind = 'pullImage'`,
        [deploymentId, state, error],
      );
      await admin().query(
        `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE deployment_id = $1 AND state = 'queued'`,
        [deploymentId],
      );
    }
    const deployment = await fixture
      .get(
        `${fixture.environment}/applications/${applicationId}/deployments/${deploymentId}`,
        'owner',
      )
      .expect(200);
    const actions = await fixture
      .get(`${fixture.environment}/applications/${applicationId}/agent-actions`, 'owner')
      .expect(200);
    const pull = (
      actions.body as { items: { kind: string; outcome: string; reason: string | null }[] }
    ).items.find((item) => item.kind === 'pullImage');
    const body = deployment.body as { deployment?: { state: string; error: string | null } };
    return {
      deployment: body.deployment ?? (deployment.body as { state: string; error: string | null }),
      pull,
      everything: JSON.stringify([deployment.body, actions.body]),
    };
  }

  it('says that the registry refused the image, and what to check', async () => {
    const seen = await failedAtThePull('refused-api', 'compensated', 'registry refused the pull');
    expect(seen.deployment).toMatchObject({
      state: 'failed',
      error:
        'The server could not pull the image: the registry refused it. The image is private, the stored credentials are wrong, or it does not exist.',
    });
    expect(seen.pull).toMatchObject({ outcome: 'compensated', reason: 'registry_denied' });
  });

  it('keeps the plain message when the agent names no cause', async () => {
    const seen = await failedAtThePull('plain-api', 'compensated', 'action failed');
    expect(seen.deployment).toMatchObject({
      state: 'failed',
      error: 'Step pull compensated: action failed',
    });
    expect(seen.pull).toMatchObject({ outcome: 'compensated', reason: null });
  });

  it('repeats nowhere a text the agent sent that it does not know', async () => {
    for (const [name, state] of [
      ['hostile-undone-api', 'compensated'],
      ['hostile-failed-api', 'failed'],
    ] as const) {
      const seen = await failedAtThePull(name, state, HOSTILE);
      expect(seen.deployment).toMatchObject({ state: 'failed', error: `Step pull ${state}.` });
      expect(seen.everything).not.toContain('sk_test_fake');
      expect(seen.everything).not.toContain('registry.example.com');
    }
  });
});

import { fromBinary } from '@bufbuild/protobuf';
import { ActionRequestSchema, type PullImage } from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AGENT_ACTION_STORE, type AgentActionStore } from '../fleet/application/ports';

import { DeploymentPipeline } from './application/deployment-pipeline';

/** Obviously fake: no real token has this shape. */
const PASSWORD = 'sk_test_fake_registry_password_pull';
const DIGEST = `sha256:${'c'.repeat(64)}`;

/** Issue #325, ADR 0019: a deployment pulls with what the organization stored for the registry. */
describe('deploying an image of a private registry', () => {
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-private.example.com',
        architecture: 'amd64',
        // Room for every application of this file: each one reserves one CPU and 512 MiB.
        cpu_count: 16,
        memory_bytes: 2 ** 35,
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

  /** Deploys an image and returns the pull the node was sent, as the agent decodes it. */
  async function pullOf(name: string, image: string): Promise<{ pull: PullImage; raw: Buffer }> {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        // Already pinned: the test asks no registry.
        config: { version: 1, name, build: { type: 'image', image }, run: { port: 3000 } },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;
    const key = `d:${deploymentId}:pull:${nodeId}`;
    const pipeline = fixture.app.get(DeploymentPipeline);
    for (let round = 0; round < 10; round++) {
      await pipeline.run(fixture.organizationId, deploymentId, () => NOW);
      const stored = await fixture.app
        .get(PrismaUnitOfWork)
        .runTenant(fixture.organizationId, () =>
          fixture.app
            .get<AgentActionStore>(AGENT_ACTION_STORE)
            .findByKey(fixture.organizationId, nodeId, key),
        );
      if (stored) {
        const { action } = fromBinary(ActionRequestSchema, stored.payload);
        if (action.case !== 'pullImage') throw new Error('the pull action is not a pull');
        const rows = await admin.query<{ payload_enc: Buffer }>(
          'SELECT payload_enc FROM agent_actions WHERE id = $1',
          [stored.id],
        );
        expect(rows.rows).toHaveLength(1);
        return { pull: action.value, raw: Buffer.concat(rows.rows.map((row) => row.payload_enc)) };
      }
      await admin.query(
        `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE deployment_id = $1 AND state = 'queued'`,
        [deploymentId],
      );
    }
    throw new Error('no image was pulled');
  }

  it('sends the stored credentials with the pull, for that registry only', async () => {
    await fixture
      .post(`${fixture.root}/registries`, 'owner', {
        server: 'ghcr.io',
        username: 'deploy-bot',
        password: PASSWORD,
      })
      .expect(200);

    const { pull, raw } = await pullOf('private-api', `ghcr.io/acme/private@${DIGEST}`);
    expect(pull.imageRef).toBe(`ghcr.io/acme/private@${DIGEST}`);
    expect(pull.registryCredentials).toMatchObject({
      server: 'ghcr.io',
      username: 'deploy-bot',
      password: PASSWORD,
    });
    // Valid for as long as the action that carries them: one hour.
    expect(Number(pull.registryCredentials?.expiresAt?.seconds)).toBe(
      Math.floor((NOW.getTime() + 3600_000) / 1000),
    );
    // In the queue the action is ciphertext, like every action payload.
    expect(raw.includes(Buffer.from(PASSWORD))).toBe(false);
    expect(raw.includes(Buffer.from('deploy-bot'))).toBe(false);

    // Another registry, and Docker Hub, get nothing of it.
    // A real host: even a pinned reference has its registry's address checked.
    const other = await pullOf('other-api', `quay.io/acme/private@${DIGEST}`);
    expect(other.pull.registryCredentials).toBeUndefined();
    const hub = await pullOf('hub-api', `acme/private@${DIGEST}`);
    expect(hub.pull.registryCredentials).toBeUndefined();
  });

  it('sends Docker Hub credentials for an image written without a registry', async () => {
    await fixture
      .post(`${fixture.root}/registries`, 'owner', {
        server: 'index.docker.io',
        username: 'hub-bot',
        password: PASSWORD,
      })
      .expect(200);
    const { pull } = await pullOf('hub-private-api', `acme/hub-private@${DIGEST}`);
    expect(pull.registryCredentials).toMatchObject({ server: 'docker.io', username: 'hub-bot' });
  });

  it('pulls anonymously again once the credentials are removed', async () => {
    // Stored here, so that this case does not depend on another one having run.
    const stored = await fixture
      .post(`${fixture.root}/registries`, 'owner', {
        server: 'ghcr.io',
        username: 'deploy-bot',
        password: PASSWORD,
      })
      .expect(200);
    await fixture
      .post(`${fixture.root}/registries/${(stored.body as { id: string }).id}/remove`, 'owner', {})
      .expect(204);
    const { pull } = await pullOf('public-again-api', `ghcr.io/acme/public@${DIGEST}`);
    expect(pull.registryCredentials).toBeUndefined();
  });

  it('fails the deployment with a reason when the stored password cannot be read', async () => {
    await fixture
      .post(`${fixture.root}/registries`, 'owner', {
        server: 'registry.example.com',
        username: 'deploy-bot',
        password: PASSWORD,
      })
      .expect(200);
    // A row altered behind the application: the ciphertext no longer authenticates.
    await admin.query(
      `UPDATE registry_credentials SET password_enc = set_byte(password_enc, length(password_enc) - 1,
         get_byte(password_enc, length(password_enc) - 1) # 1) WHERE server = 'registry.example.com'`,
    );
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'unreadable-api',
          build: { type: 'image', image: `registry.example.com/acme/private@${DIGEST}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;
    expect(
      await fixture.app
        .get(DeploymentPipeline)
        .run(fixture.organizationId, deploymentId, () => NOW),
    ).toBe('done');
    const state = await admin.query<{ state: string; error: string | null }>(
      'SELECT state, error FROM deployments WHERE id = $1',
      [deploymentId],
    );
    expect(state.rows).toEqual([
      {
        state: 'failed',
        error: 'The stored credentials for registry.example.com cannot be read; store them again.',
      },
    ]);
    expect(JSON.stringify(state.rows)).not.toContain(PASSWORD);
  });
});

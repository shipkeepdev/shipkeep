import * as x509 from '@peculiar/x509';
import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { EnrollNode } from '../fleet/application/enroll-node';
import { IssueJoinToken } from '../fleet/application/issue-join-token';
import { NodeLiveness } from '../fleet/application/node-liveness';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from '../fleet/infrastructure/ca/x509';

import { DeploymentPipeline } from './application/deployment-pipeline';

async function agentCsr(): Promise<string> {
  const pair = await generateEd25519KeyPair();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent',
    keys: {
      publicKey: await importPublicKey(pair.publicKeyPem),
      privateKey: await importPrivateKey(pair.privateKeyPem),
    },
    signingAlgorithm: SIGNING_ALGORITHM,
  });
  return csr.toString('pem');
}

/** PLAN M3.4c4c: a queued deployment gets its pipeline job and starts on a ready node. */
describe('deployment pipeline with PostgreSQL and pg-boss', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    const token = await fixture.app.get(IssueJoinToken).execute({
      organizationId: fixture.organizationId,
      actor: { kind: 'user', id: fixture.actors.owner.id },
    });
    nodeId = (
      await fixture.app.get(EnrollNode).execute({
        joinToken: token.value,
        csrPem: await agentCsr(),
        facts: {
          hostname: 'edge-run.example.com',
          architecture: 'amd64',
          cpu_count: 2,
          memory_bytes: 2 ** 32,
        },
        agentVersion: '0.1.0',
      })
    ).nodeId;
    await fixture.app
      .get(NodeLiveness)
      .heartbeat({ organizationId: fixture.organizationId, nodeId, serial: '' });
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
      const placed = await admin.query('SELECT replica FROM allocations WHERE node_id = $1', [
        nodeId,
      ]);
      expect(placed.rowCount).toBe(1);
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
});

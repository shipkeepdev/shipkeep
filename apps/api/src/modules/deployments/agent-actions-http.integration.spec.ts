import { create } from '@bufbuild/protobuf';
import * as x509 from '@peculiar/x509';
import {
  type ActionRequest,
  ActionRequestSchema,
  ActionUpdateSchema,
  OperationState,
} from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { tenantHttpFixture } from '../../testing/tenant-http';
import { AgentActions } from '../fleet/application/agent-actions';
import { EnrollNode } from '../fleet/application/enroll-node';
import { IssueJoinToken } from '../fleet/application/issue-join-token';
import { NodeLiveness } from '../fleet/application/node-liveness';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from '../fleet/infrastructure/ca/x509';
import { ResourceCommands } from '../organizations/application/resource-commands';

import { DeploymentPipeline } from './application/deployment-pipeline';

// Obviously fake values that must never leave the encrypted payload or the raw agent report.
const SECRET_VALUE = 'sk_test_fake_secret_value_263';
const REGISTRY_PASSWORD = 'fake-registry-password-263';
const CONFIRMATION = 'fake-confirmation-token-263';
const OUTPUT = 'DATABASE_URL=postgres://user:fake-output-263@db.example.com/app';
const HEALTH_ERROR = 'GET /health?token=fake-health-263 failed';
const IMAGE = `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}`;
const CONTAINER = 'f'.repeat(64);

interface Page {
  items: {
    id: string;
    kind: string;
    nodeId: string;
    nodeName: string;
    state: string;
    outcome: string;
    reason: string | null;
    result: Record<string, unknown> | null;
    deploymentId: string | null;
    completedAt: string | null;
  }[];
  nextCursor: string | null;
}

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

function action(init: unknown): ActionRequest['action'] {
  return create(ActionRequestSchema, { action: init as ActionRequest['action'] }).action;
}

/** Issue #263: an application's agent actions, refusals included, with nothing secret. */
describe('agent actions of an application over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let actions: AgentActions;
  let nodeId: string;
  let applicationId: string;
  let application: string;
  let deploymentId: string;
  let foreign: { nodeId: string; applicationId: string; deploymentId: string; path: string };

  const enrol = async (organizationId: string, hostname: string) => {
    const token = await fixture.app.get(IssueJoinToken).execute({
      organizationId,
      actor: { kind: 'user', id: fixture.actors.owner.id },
    });
    const id = (
      await fixture.app.get(EnrollNode).execute({
        joinToken: token.value,
        csrPem: await agentCsr(),
        facts: { hostname, architecture: 'amd64', cpu_count: 2, memory_bytes: 2 ** 32 },
        agentVersion: '0.1.0',
      })
    ).nodeId;
    await fixture.app.get(NodeLiveness).heartbeat({ organizationId, nodeId: id, serial: '' });
    return id;
  };
  const deploy = async (environment: string, name: string) => {
    const created = await fixture
      .post(`${environment}/applications`, 'owner', {
        config: { version: 1, name, build: { type: 'image', image: IMAGE }, run: { port: 3000 } },
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const queued = await fixture
      .post(`${environment}/applications/${id}/deployments`, 'owner', {})
      .expect(201);
    return { id, deploymentId: (queued.body as { deployment: { id: string } }).deployment.id };
  };
  const enqueue = (
    organizationId: string,
    node: string,
    key: string,
    request: ActionRequest['action'],
    origin?: { applicationId: string; deploymentId: string },
    deadline = new Date(Date.now() + 600_000),
  ) =>
    actions.enqueue({
      organizationId,
      nodeId: node,
      idempotencyKey: key,
      action: request,
      deadline,
      actor: { kind: 'system' },
      ...(origin ? { origin } : {}),
    });
  const report = (id: string, update: Record<string, unknown>) =>
    actions.record(
      { organizationId: fixture.organizationId, nodeId, serial: '' },
      create(ActionUpdateSchema, { actionId: id, ...update }),
    );
  const page = async (query = '', actor: Parameters<typeof fixture.get>[1] = 'owner') =>
    (await fixture.get(`${application}/agent-actions${query}`, actor).expect(200)).body as Page;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    actions = fixture.app.get(AgentActions);
    nodeId = await enrol(fixture.organizationId, 'edge-actions.example.com');
    ({ id: applicationId, deploymentId } = await deploy(fixture.environment, 'actions-api'));
    application = `${fixture.environment}/applications/${applicationId}`;

    // A second organization with its own application, deployment and node.
    const resources = fixture.app.get(ResourceCommands);
    const projectId = (
      await resources.createProject(fixture.owner, fixture.foreignId, {
        name: 'Foreign',
        slug: 'foreign-project',
      })
    ).id;
    const environmentId = (
      await resources.createEnvironment(
        fixture.owner,
        { organizationId: fixture.foreignId, projectId },
        { name: 'production' },
      )
    ).id;
    const path = `/api/v1/organizations/${fixture.foreignId}/projects/${projectId}/environments/${environmentId}`;
    const other = await deploy(path, 'foreign-api');
    foreign = {
      nodeId: await enrol(fixture.foreignId, 'edge-foreign.example.com'),
      applicationId: other.id,
      deploymentId: other.deploymentId,
      path: `${path}/applications/${other.id}`,
    };
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('starts empty and links the actions the pipeline enqueues to their deployment', async () => {
    expect(await page()).toEqual({ items: [], nextCursor: null });
    expect(
      await fixture.app.get(DeploymentPipeline).run(fixture.organizationId, deploymentId),
    ).toBe('wait');
    const listed = await page();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      kind: 'ensureNetwork',
      nodeId,
      nodeName: 'edge-actions',
      state: 'queued',
      outcome: 'in_progress',
      reason: null,
      result: null,
      deploymentId,
      completedAt: null,
    });
  });

  it('lists outcomes and refusals newest first, without payloads or raw agent text', async () => {
    const spec = {
      name: 'sk-actions-api-0',
      imageRef: IMAGE,
      env: [{ name: 'MODE', value: 'fake-env-263' }],
      secrets: [
        { name: 'DATABASE_URL', version: 1, value: new TextEncoder().encode(SECRET_VALUE) },
      ],
    };
    const credentials = {
      server: 'registry.example.com',
      username: 'robot-263',
      password: REGISTRY_PASSWORD,
    };
    const succeeded = (result: unknown) => ({
      state: OperationState.SUCCEEDED,
      result: { result },
    });
    // Request, what the agent reports, then the expected kind, outcome and reason.
    const cases: [unknown, Record<string, unknown>, string][] = [
      [
        { case: 'createContainer', value: { spec } },
        { ...succeeded({ case: 'containerId', value: CONTAINER }), step: 'created', attempts: 1 },
        'createContainer succeeded -',
      ],
      [
        { case: 'pullImage', value: { imageRef: IMAGE, registryCredentials: credentials } },
        // How the agent refuses a request fenced by an expired lease (SPEC 3.4).
        { state: OperationState.FAILED, error: 'stale lease epoch' },
        'pullImage refused stale_lease_epoch',
      ],
      [
        {
          case: 'removeContainer',
          value: { containerId: CONTAINER, confirmationToken: CONFIRMATION },
        },
        // A buggy or hostile agent echoing its input is mapped to a code, never shown.
        { state: OperationState.FAILED, error: `bad ${CONFIRMATION}` },
        'removeContainer failed unknown',
      ],
      [
        { case: 'runReleaseTask', value: { spec } },
        succeeded({ case: 'releaseTask', value: { exitCode: 1, outputTail: OUTPUT } }),
        'runReleaseTask succeeded -',
      ],
      [
        { case: 'healthCheck', value: { containerId: CONTAINER } },
        succeeded({ case: 'healthCheck', value: { healthy: false, lastError: HEALTH_ERROR } }),
        'healthCheck succeeded -',
      ],
    ];
    for (const [index, [request, update]] of cases.entries()) {
      const queued = await enqueue(
        fixture.organizationId,
        nodeId,
        `d:${deploymentId}:t:${String(index)}`,
        action(request),
        { applicationId, deploymentId },
      );
      await report(queued.id, update);
    }
    // The control plane expires an action whose deadline passed before the agent answered.
    await enqueue(
      fixture.organizationId,
      nodeId,
      `d:${deploymentId}:t:late`,
      action({ case: 'startContainer', value: { containerId: CONTAINER } }),
      { applicationId, deploymentId },
      new Date(Date.now() + 1000),
    );
    await actions.deliverable(
      { organizationId: fixture.organizationId, nodeId, serial: '' },
      new Set(),
      new Date(Date.now() + 60_000),
    );
    // Not requested by a deployment: never listed for the application.
    await enqueue(
      fixture.organizationId,
      nodeId,
      'facts:263',
      action({ case: 'collectFacts', value: {} }),
    );

    const listed = await page('', 'environmentViewer');
    expect(listed.nextCursor).toBeNull();
    expect(listed.items.map((i) => `${i.kind} ${i.outcome} ${i.reason ?? '-'}`)).toEqual([
      'startContainer expired -',
      ...cases.map((c) => c[2]).reverse(),
      'ensureNetwork in_progress -',
    ]);
    const fields = (result: Record<string, unknown> | null) =>
      result && Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
    expect(listed.items.map((item) => fields(item.result))).toEqual([
      null,
      { type: 'health_check', healthy: false },
      { type: 'release_task', exitCode: 1 },
      null,
      null,
      { type: 'container', containerId: CONTAINER },
      null,
    ]);
    expect(listed.items.map((item) => item.state)).toEqual([
      'expired',
      'succeeded',
      'succeeded',
      'failed',
      'failed',
      'succeeded',
      'queued',
    ]);
    expect(
      listed.items.every((item) => item.deploymentId === deploymentId && item.nodeId === nodeId),
    ).toBe(true);

    const raw = JSON.stringify(listed);
    const secrets = [SECRET_VALUE, REGISTRY_PASSWORD, CONFIRMATION, 'robot-263', 'fake-env-263'];
    for (const secret of [...secrets, 'fake-output-263', 'fake-health-263'])
      expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/payload|idempotency|lastError|outputTail/i);
  });

  it('pages with an exclusive cursor and refuses malformed pages', async () => {
    const all = (await page()).items.map((item) => item.id);
    expect(all).toHaveLength(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: Page = await page(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(next.items.length).toBeLessThanOrEqual(3);
      seen.push(...next.items.map((item) => item.id));
      cursor = next.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    expect((await page('?limit=7')).nextCursor).toBeNull();
    expect((await page('?limit=6')).nextCursor).toBe(all[5]);

    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?cursor=..%2F..%2Fetc',
      `?cursor=${encodeURIComponent("' OR 1=1 --")}`,
      `?cursor=${'a'.repeat(4096)}`,
      '?state=failed',
    ])
      await fixture.get(`${application}/agent-actions${query}`).expect(400);
  });

  it('keeps each organization to its own actions', async () => {
    const foreignAction = await enqueue(
      fixture.foreignId,
      foreign.nodeId,
      `d:${foreign.deploymentId}:test`,
      action({ case: 'collectFacts', value: {} }),
      { applicationId: foreign.applicationId, deploymentId: foreign.deploymentId },
    );
    const foreignPage = (await fixture.get(`${foreign.path}/agent-actions`).expect(200))
      .body as Page;
    expect(foreignPage.items.map((item) => item.id)).toEqual([foreignAction.id]);
    expect((await page()).items.map((item) => item.id)).not.toContain(foreignAction.id);

    // Row security alone hides the other organization's rows, even without a filter.
    const visible = await fixture.database.runTenant(fixture.foreignId, () =>
      fixture.database.client.agentAction.findMany({ select: { applicationId: true } }),
    );
    expect(visible.map((row) => row.applicationId)).not.toContain(applicationId);
    expect(await actions.history(fixture.foreignId, applicationId, undefined, 10)).toEqual([]);

    // The application of one organization is not reachable under another one.
    await fixture
      .get(`${foreign.path.replace(foreign.applicationId, applicationId)}/agent-actions`)
      .expect(404);
    await fixture.get(`${application}/agent-actions`, 'outsider').expect(404);
  });

  it('links an action only to a deployment of its own organization', async () => {
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      await expect(
        admin.query(
          'UPDATE agent_actions SET application_id = $2, deployment_id = $3 WHERE organization_id = $1',
          [fixture.foreignId, applicationId, deploymentId],
        ),
      ).rejects.toThrow(/agent_actions_deployment_fkey/);
    } finally {
      await admin.end();
    }
  });
});

import { create } from '@bufbuild/protobuf';
import { EnsureNetworkSchema } from '@shipkeep/proto-ts';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AgentActions } from '../fleet/application/agent-actions';

import { PIPELINE_STORE, type PipelineStore } from './application/ports';

/** PLAN M3.4c4a: allocations, digests and step outcomes in the tenant context. */
describe('pipeline store', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let applicationId: string;
  let releaseId: string;
  let deploymentId: string;
  const tenant = <T>(work: (store: PipelineStore) => Promise<T>) =>
    fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        work(fixture.app.get<PipelineStore>(PIPELINE_STORE)),
      );

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-pipeline.example.com', architecture: 'amd64', cpu_count: 2 },
      ready: false,
    });
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'billing-api',
          build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
          run: { port: 3000 },
        },
      })
      .expect(201);
    applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const body = queued.body as { release: { id: string }; deployment: { id: string } };
    releaseId = body.release.id;
    deploymentId = body.deployment.id;
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('places, loads and stops replicas once', async () => {
    const replica = {
      index: 0,
      nodeId,
      container: 'sk-billing-api-0123456789ab-r1-0',
      port: 3000,
      cpuMillis: 500,
      memoryBytes: 2 ** 29,
    };
    const now = new Date();
    expect(
      await tenant((s) =>
        s.place(fixture.organizationId, applicationId, releaseId, [replica], now),
      ),
    ).toBe(true);
    expect(
      await tenant((s) =>
        s.place(fixture.organizationId, applicationId, releaseId, [replica], now),
      ),
    ).toBe(false);
    expect(await tenant((s) => s.allocations(applicationId))).toEqual([
      expect.objectContaining({ ...replica, releaseId }),
    ]);
    expect((await tenant((s) => s.load(fixture.organizationId))).get(nodeId)).toEqual({
      cpuMillis: 500,
      memoryBytes: 2 ** 29,
      applications: [applicationId],
    });
    const nodes = await tenant((s) => s.nodes(fixture.organizationId));
    expect(nodes.find((n) => n.id === nodeId)).toMatchObject({
      name: 'edge-pipeline',
      facts: { cpu_count: 2 },
    });
    // A deployment that replaces this release does not count it (SPEC 6); any other one does.
    const next = '0190f5a8-7b1c-7e2d-8f3a-0000000000f2';
    expect(
      (await tenant((s) => s.load(fixture.organizationId, { applicationId, releaseId: next }))).get(
        nodeId,
      ),
    ).toEqual({ cpuMillis: 0, memoryBytes: 0, applications: [applicationId] });
    expect(
      (await tenant((s) => s.load(fixture.organizationId, { applicationId, releaseId }))).get(
        nodeId,
      ),
    ).toEqual({ cpuMillis: 500, memoryBytes: 2 ** 29, applications: [applicationId] });
    expect(
      (
        await tenant((s) =>
          s.load(fixture.organizationId, { applicationId: next, releaseId: next }),
        )
      ).get(nodeId),
    ).toEqual({ cpuMillis: 500, memoryBytes: 2 ** 29, applications: [applicationId] });
    await tenant((s) => s.stop(applicationId, [releaseId], now));
    expect(await tenant((s) => s.allocations(applicationId))).toEqual([]);
    // Stopped replicas are in no load: their room cannot be freed a second time.
    expect(
      (await tenant((s) => s.load(fixture.organizationId, { applicationId, releaseId: next }))).has(
        nodeId,
      ),
    ).toBe(false);
  });

  it('records a release digest once and reads the deployment steps by prefix', async () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    expect(await tenant((s) => s.recordDigest(releaseId, digest))).toBe(true);
    expect(await tenant((s) => s.recordDigest(releaseId, `sha256:${'e'.repeat(64)}`))).toBe(false);
    expect((await tenant((s) => s.release(releaseId)))?.imageDigest).toBe(digest);

    await fixture.app.get(AgentActions).enqueue({
      organizationId: fixture.organizationId,
      nodeId,
      idempotencyKey: `d:${deploymentId}:net:${nodeId}`,
      action: {
        case: 'ensureNetwork',
        value: create(EnsureNetworkSchema, { name: 'sk-env-test' }),
      },
      deadline: new Date(Date.now() + 60_000),
      actor: { kind: 'system' },
    });
    await fixture.app.get(AgentActions).enqueue({
      organizationId: fixture.organizationId,
      nodeId,
      idempotencyKey: `d:0190f5a8-7b1c-7e2d-8f3a-0123456789ff:net:${nodeId}`,
      action: {
        case: 'ensureNetwork',
        value: create(EnsureNetworkSchema, { name: 'sk-env-other' }),
      },
      deadline: new Date(Date.now() + 60_000),
      actor: { kind: 'system' },
    });
    const steps = await tenant((s) => s.steps(deploymentId));
    expect([...steps]).toEqual([
      [`d:${deploymentId}:net:${nodeId}`, { state: 'queued', reason: null }],
    ]);
  });
});

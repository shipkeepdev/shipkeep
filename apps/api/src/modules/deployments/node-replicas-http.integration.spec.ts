import { create } from '@bufbuild/protobuf';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { ApiTokenCommands } from '../identity/application/api-token-commands';

import { AllocationObservations } from './application/allocation-observations';
import { PIPELINE_STORE, type PipelineStore } from './application/ports';

const CONTAINER = 'sk-shop-web-0123456789ab-r1-0';
const OTHER = 'sk-shop-web-0123456789ab-r1-1';

/** Issue #264: one server and what runs on it, for owners and administrators only. */
describe('a server and its replicas over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const resetLimits = () => fixture.prisma.identityThrottle.deleteMany();

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  async function placeApplication(name: string, nodeId: string, containers: string[]) {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name,
          build: { type: 'image', image: 'nginx:alpine' },
          run: { port: 80 },
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const releaseId = (queued.body as { release: { id: string } }).release.id;
    await fixture.app.get(PrismaUnitOfWork).runTenant(fixture.organizationId, () =>
      fixture.app.get<PipelineStore>(PIPELINE_STORE).place(
        fixture.organizationId,
        applicationId,
        releaseId,
        containers.map((container, index) => ({
          index,
          nodeId,
          container,
          port: 80,
          cpuMillis: 250,
          memoryBytes: 268_435_456,
        })),
        new Date(),
      ),
    );
    return { applicationId, releaseId };
  }

  it('shows a server and the replicas it runs, with where each belongs', async () => {
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-detail.example.com' },
      ready: false,
    });
    const otherNode = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-elsewhere.example.com' },
      ready: false,
    });
    const shop = await placeApplication('shop-web', nodeId, [CONTAINER, OTHER]);
    // Another application on another server is not listed.
    await placeApplication('elsewhere', otherNode, ['sk-elsewhere-0123456789ab-r1-0']);
    await fixture.app.get(AllocationObservations).record(
      { organizationId: fixture.organizationId, nodeId, serial: '' },
      create(StateReportSchema, {
        containers: [
          { containerId: 'f'.repeat(64), name: CONTAINER, state: ContainerStatus_State.RUNNING },
        ],
      }),
    );

    const node = await fixture.get(`${fixture.root}/nodes/${nodeId}`, 'admin').expect(200);
    expect(node.body).toMatchObject({ id: nodeId, name: 'edge-detail', status: 'enrolling' });

    const replicas = await fixture
      .get(`${fixture.root}/nodes/${nodeId}/replicas`, 'admin')
      .expect(200);
    const body = replicas.body as {
      items: { container: string; state: string | null }[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    expect(body.items).toEqual([
      {
        id: expect.any(String) as string,
        releaseId: shop.releaseId,
        replica: 0,
        container: CONTAINER,
        cpuMillis: 250,
        memoryBytes: 268_435_456,
        placedAt: expect.any(String) as string,
        application: { id: shop.applicationId, name: 'shop-web' },
        project: { id: fixture.projectId, name: expect.any(String) as string },
        environment: { id: fixture.environmentId, name: expect.any(String) as string },
        state: 'running',
        stopReason: null,
        observedAt: expect.any(String) as string,
      },
      expect.objectContaining({ replica: 1, container: OTHER, state: null, observedAt: null }),
    ]);

    // A stopped replica no longer runs there.
    const database = fixture.app.get(PrismaUnitOfWork);
    const stopped = await database.runTenant(fixture.organizationId, () =>
      database.client.allocation.updateMany({
        where: { container: OTHER },
        data: { state: 'stopped' },
      }),
    );
    expect(stopped.count).toBe(1);
    const after = await fixture
      .get(`${fixture.root}/nodes/${nodeId}/replicas`, 'owner')
      .expect(200);
    expect((after.body as typeof body).items.map((item) => item.container)).toEqual([CONTAINER]);
  });

  it('answers 404 to members, to other organizations and for unknown servers', async () => {
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-private.example.com' },
      ready: false,
    });
    for (const path of [`nodes/${nodeId}`, `nodes/${nodeId}/replicas`]) {
      for (const actor of ['member', 'projectAdmin', 'environmentViewer', 'outsider'] as const) {
        await resetLimits();
        await fixture.get(`${fixture.root}/${path}`, actor).expect(404);
      }
      // The fixture owner also owns the foreign organization: this server is not in it.
      await resetLimits();
      await fixture.get(`/api/v1/organizations/${fixture.foreignId}/${path}`, 'owner').expect(404);
    }
    const unknown = '01900000-0000-7000-8000-0000000000ff';
    await resetLimits();
    await fixture.get(`${fixture.root}/nodes/${unknown}`, 'owner').expect(404);
    await fixture.get(`${fixture.root}/nodes/${unknown}/replicas`, 'owner').expect(404);
    await fixture.get(`${fixture.root}/nodes/not-a-uuid/replicas`, 'owner').expect(400);
  });

  it('refuses API tokens, even with node.manage', async () => {
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-token.example.com' },
      ready: false,
    });
    const user = await fixture.prisma.user.findUniqueOrThrow({
      where: { id: fixture.actors.admin.id },
    });
    const grant = await fixture.app.get(ApiTokenCommands).create(
      { ...fixture.owner, userId: user.id, securityVersion: user.securityVersion },
      {
        name: 'Fleet reader',
        scopes: [{ permission: 'node.manage', organizationId: fixture.organizationId }],
        expiresAt: new Date(Date.now() + 3600_000),
      },
      fixture.password,
      {},
    );
    const bearer = `Bearer ${grant.token.expose()}`;
    // The token is good: a route open to node.manage tokens accepts it.
    await resetLimits();
    await fixture
      .http()
      .post(`${fixture.root}/nodes/${nodeId}/public-addresses`)
      .set('Authorization', bearer)
      .send({ publicAddresses: [] })
      .expect(200);
    for (const path of [`nodes/${nodeId}`, `nodes/${nodeId}/replicas`]) {
      await resetLimits();
      const response = await fixture
        .http()
        .get(`${fixture.root}/${path}`)
        .set('Authorization', bearer)
        .expect(401);
      expect(JSON.stringify(response.body)).not.toContain('edge-token');
    }
  });
});

import { create } from '@bufbuild/protobuf';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { AllocationObservations } from './application/allocation-observations';
import { PIPELINE_STORE, type PipelineStore } from './application/ports';

const CONTAINER = 'sk-observed-api-0123456789ab-r1-0';
const report = (state: ContainerStatus_State) =>
  create(StateReportSchema, {
    containers: [{ containerId: 'f'.repeat(64), name: CONTAINER, state }],
  });

/** PLAN M1.6b2: observations stay apart from reservations and bound to the reporting node. */
describe('allocation observations with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const enroll = (hostname: string) =>
    enrollTestNode(fixture, { facts: { hostname }, ready: false });

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('records only the reporting node, audits changes and leaves reservations alone', async () => {
    const nodeId = await enroll('edge-observed.example.com');
    const otherNode = await enroll('edge-other.example.com');
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'observed-api',
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
    await fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get<PipelineStore>(PIPELINE_STORE)
          .place(
            fixture.organizationId,
            applicationId,
            releaseId,
            [{ index: 0, nodeId, container: CONTAINER, port: 80, cpuMillis: 0, memoryBytes: 0 }],
            new Date(),
          ),
      );
    const observations = fixture.app.get(AllocationObservations);
    const as = (id: string) => ({ organizationId: fixture.organizationId, nodeId: id, serial: '' });

    // Another node reporting the same container name touches nothing.
    await observations.record(as(otherNode), report(ContainerStatus_State.RUNNING));
    await observations.record(as(nodeId), report(ContainerStatus_State.RUNNING));
    await observations.record(as(nodeId), report(ContainerStatus_State.RUNNING));
    await observations.record(as(nodeId), report(ContainerStatus_State.EXITED));
    await observations.record(as(nodeId), create(StateReportSchema, {}));

    const replicas = await fixture
      .get(`${fixture.environment}/applications/${applicationId}/replicas`, 'environmentViewer')
      .expect(200);
    expect((replicas.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        nodeId,
        nodeName: 'edge-observed',
        container: CONTAINER,
        state: 'missing',
      }),
    ]);

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{
        observed: string;
        container_id: string | null;
        reserved: string;
      }>(
        `SELECT o.state AS observed, o.container_id, a.state AS reserved
           FROM allocation_observations o JOIN allocations a ON a.id = o.allocation_id`,
      );
      expect(rows.rows).toEqual([{ observed: 'missing', container_id: null, reserved: 'placed' }]);
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({
      where: { action: 'allocation.observed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => [event.actorId, event.metadata])).toEqual([
      [nodeId, expect.objectContaining({ from: null, to: 'running' })],
      [nodeId, expect.objectContaining({ from: 'running', to: 'exited' })],
      [nodeId, expect.objectContaining({ from: 'exited', to: 'missing' })],
    ]);
  });

  it('shows why the agent stopped a replica, while its container exists (ADR 0022)', async () => {
    const nodeId = await enroll('edge-full.example.com');
    const name = 'sk-full-api-0123456789ab-r1-0';
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'full-api',
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
    await fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get<PipelineStore>(PIPELINE_STORE)
          .place(
            fixture.organizationId,
            applicationId,
            releaseId,
            [{ index: 0, nodeId, container: name, port: 80, cpuMillis: 0, memoryBytes: 0 }],
            new Date(),
          ),
      );
    const observations = fixture.app.get(AllocationObservations);
    const as = { organizationId: fixture.organizationId, nodeId, serial: '' };
    const container = (state: ContainerStatus_State, stopReason = '') =>
      create(StateReportSchema, {
        containers: [{ containerId: 'e'.repeat(64), name, state, stopReason }],
      });
    const replicas = async () =>
      (
        (
          await fixture
            .get(
              `${fixture.environment}/applications/${applicationId}/replicas`,
              'environmentViewer',
            )
            .expect(200)
        ).body as { items: { state: string; stopReason: string | null }[] }
      ).items;
    await observations.record(as, container(ContainerStatus_State.RUNNING));
    expect(await replicas()).toMatchObject([{ state: 'running', stopReason: null }]);
    await observations.record(as, container(ContainerStatus_State.EXITED, 'disk_limit'));
    expect(await replicas()).toMatchObject([{ state: 'exited', stopReason: 'disk_limit' }]);
    // Gone, the container has no reason any more.
    await observations.record(as, create(StateReportSchema, {}));
    expect(await replicas()).toMatchObject([{ state: 'missing', stopReason: null }]);
    const events = await auditLog().findMany({
      where: { action: 'allocation.observed', actorId: nodeId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ from: null, to: 'running' }),
      expect.objectContaining({ from: 'running', to: 'exited', stopReason: 'disk_limit' }),
      expect.objectContaining({ from: 'exited', to: 'missing' }),
    ]);
  });
});

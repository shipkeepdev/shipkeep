import { create } from '@bufbuild/protobuf';
import * as x509 from '@peculiar/x509';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { EnrollNode } from '../fleet/application/enroll-node';
import { IssueJoinToken } from '../fleet/application/issue-join-token';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from '../fleet/infrastructure/ca/x509';

import { AllocationObservations } from './application/allocation-observations';
import { PIPELINE_STORE, type PipelineStore } from './application/ports';

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

const CONTAINER = 'sk-observed-api-0123456789ab-r1-0';
const report = (state: ContainerStatus_State) =>
  create(StateReportSchema, {
    containers: [{ containerId: 'f'.repeat(64), name: CONTAINER, state }],
  });

/** PLAN M1.6b2: observations stay apart from reservations and bound to the reporting node. */
describe('allocation observations with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const enroll = async (hostname: string) => {
    const token = await fixture.app.get(IssueJoinToken).execute({
      organizationId: fixture.organizationId,
      actor: { kind: 'user', id: fixture.actors.owner.id },
    });
    return (
      await fixture.app.get(EnrollNode).execute({
        joinToken: token.value,
        csrPem: await agentCsr(),
        facts: { hostname },
        agentVersion: '0.1.0',
      })
    ).nodeId;
  };

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
});

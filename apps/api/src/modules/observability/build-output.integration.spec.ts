import { create } from '@bufbuild/protobuf';
import { SYSTEM_ACTOR } from '@shipkeep/domain';
import { BuildImageSchema, PullImageSchema } from '@shipkeep/proto-ts';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AgentActions } from '../fleet/application/agent-actions';

import { METRICS_TARGETS, type MetricsTargets } from './application/ports';

/**
 * ADR 0032 with PostgreSQL: a node's build output is labelled only through a build action the
 * control plane queued on that node for a deployment.
 */
describe('build output targets', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it("finds a build's deployment from the action, on the node it was queued on only", async () => {
    const nodeId = await enrollTestNode(fixture, { facts: { hostname: 'builder.example.com' } });
    const otherNode = await enrollTestNode(fixture, { facts: { hostname: 'other.example.com' } });
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'built-output',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (created.body as { id: string }).id;
    const deployed = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const deploymentId = (deployed.body as { deployment: { id: string } }).deployment.id;
    const actions = fixture.app.get(AgentActions);
    const database = fixture.app.get(PrismaUnitOfWork);
    const enqueue = (
      node: string,
      key: string,
      action: Parameters<AgentActions['enqueue']>[0]['action'],
    ) =>
      database.runTenant(fixture.organizationId, () =>
        actions.enqueue({
          organizationId: fixture.organizationId,
          nodeId: node,
          idempotencyKey: key,
          action,
          deadline: new Date(Date.now() + 3_600_000),
          actor: SYSTEM_ACTOR,
        }),
      );
    const build = { case: 'buildImage' as const, value: create(BuildImageSchema, {}) };
    const built = await enqueue(nodeId, `d:${deploymentId}:build`, build);
    const elsewhere = await enqueue(otherNode, `d:${deploymentId}:build`, build);
    const pulled = await enqueue(nodeId, `d:${deploymentId}:pull`, {
      case: 'pullImage',
      value: create(PullImageSchema, {}),
    });
    const unrelated = await enqueue(nodeId, 'exec:session', build);

    const targets = fixture.app.get<MetricsTargets>(METRICS_TARGETS);
    const found = await database.runTenant(fixture.organizationId, () =>
      targets.buildsOnNode(fixture.organizationId, nodeId, [
        built.id,
        elsewhere.id,
        pulled.id,
        unrelated.id,
        '0190f5a8-7b1c-7e2d-8f3a-0000000000ff',
      ]),
    );
    expect(found).toEqual([
      {
        actionId: built.id,
        deploymentId,
        applicationId,
        projectId: fixture.projectId,
        environmentId: fixture.environmentId,
      },
    ]);
  });
});

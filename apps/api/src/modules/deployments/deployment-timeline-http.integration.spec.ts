import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { DeploymentPipeline } from './application/deployment-pipeline';

/** Issue #265: one deployment's steps and agent actions, read back for its page. */
describe('a deployment timeline over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  const resetLimits = () => fixture.prisma.identityThrottle.deleteMany();

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-timeline.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
    });
  });
  afterAll(async () => {
    await fixture.close();
  });

  async function queue(name: string): Promise<{ applicationId: string; deploymentId: string }> {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name,
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
    return {
      applicationId,
      deploymentId: (queued.body as { deployment: { id: string } }).deployment.id,
    };
  }
  const timeline = (applicationId: string, deploymentId: string) =>
    `${fixture.environment}/applications/${applicationId}/deployments/${deploymentId}/timeline`;

  it('lists the steps a deployment went through and the actions it asked agents for', async () => {
    const { applicationId, deploymentId } = await queue('timeline-api');
    // Another application's deployment and actions stay out of this timeline.
    const other = await queue('timeline-other');
    const pipeline = fixture.app.get(DeploymentPipeline);
    expect(await pipeline.run(fixture.organizationId, deploymentId)).toBe('wait');
    expect(await pipeline.run(fixture.organizationId, other.deploymentId)).toBe('wait');

    const response = await fixture
      .get(timeline(applicationId, deploymentId), 'environmentViewer')
      .expect(200);
    const body = response.body as {
      steps: { from: string | null; to: string; at: string; reason: string | null }[];
      actions: { kind: string; nodeId: string; nodeName: string; deploymentId: string }[];
      truncated: boolean;
    };
    expect(body.steps.map((step) => [step.from, step.to, step.reason])).toEqual([
      [null, 'queued', null],
      ['queued', 'scheduling', null],
      ['scheduling', 'starting', null],
    ]);
    expect(body.steps.every((step) => !Number.isNaN(Date.parse(step.at)))).toBe(true);
    expect(body.actions).toEqual([
      expect.objectContaining({
        kind: 'ensureNetwork',
        nodeId,
        nodeName: 'edge-timeline',
        deploymentId,
      }),
    ]);
    expect(body.truncated).toBe(false);
    // Summaries only: no payload, no raw agent error.
    expect(JSON.stringify(body)).not.toMatch(/payload|payloadEnc/);
  });

  it('shows a cancelled deployment ending where it was cancelled', async () => {
    const { applicationId, deploymentId } = await queue('timeline-cancelled');
    await fixture
      .post(
        `${fixture.environment}/applications/${applicationId}/deployments/${deploymentId}/cancel`,
        'owner',
        {},
      )
      .expect(200);
    const response = await fixture.get(timeline(applicationId, deploymentId), 'owner').expect(200);
    expect(
      (response.body as { steps: { from: string | null; to: string }[] }).steps.map((step) => [
        step.from,
        step.to,
      ]),
    ).toEqual([
      [null, 'queued'],
      ['queued', 'cancelled'],
    ]);
    expect((response.body as { actions: unknown[] }).actions).toEqual([]);
  });

  it('answers 404 outside the environment, for another application and unknown deployments', async () => {
    const { applicationId, deploymentId } = await queue('timeline-private');
    const sibling = await queue('timeline-sibling');
    await resetLimits();
    for (const actor of ['outsider', 'member'] as const)
      await fixture.get(timeline(applicationId, deploymentId), actor).expect(404);
    // A deployment is only read under its own application.
    await fixture.get(timeline(sibling.applicationId, deploymentId), 'owner').expect(404);
    await fixture
      .get(timeline(applicationId, '01900000-0000-7000-8000-0000000000ff'), 'owner')
      .expect(404);
    await fixture.get(timeline(applicationId, 'not-a-uuid'), 'owner').expect(400);
  });
});

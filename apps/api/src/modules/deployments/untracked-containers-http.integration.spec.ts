import { create } from '@bufbuild/protobuf';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import type { TenantActor } from '../../testing/tenant-personas';

import { AllocationObservations } from './application/allocation-observations';
import { DeploymentPipeline } from './application/deployment-pipeline';

/**
 * Issue #501, with PostgreSQL: after a restore, a server still runs containers of deployments the
 * restored database does not know. Its page lists those of known applications, and an
 * administrator removes one on a confirmation by its name.
 */
describe('untracked containers of a server over HTTP', () => {
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-untracked.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
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

  const createApplication = async (name: string, hostname: string) =>
    (
      await fixture
        .post(`${fixture.environment}/applications`, 'owner', {
          config: {
            version: 1,
            name,
            build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
            run: { port: 3000 },
            domains: [hostname],
          },
        })
        .expect(201)
    ).body as { id: string };
  async function deploy(applicationId: string): Promise<string> {
    const application = `${fixture.environment}/applications/${applicationId}`;
    const deployed = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
      .body as { deployment: { id: string } };
    return deployed.deployment.id;
  }
  /** Places the deployment's replica, then records it as succeeded, as an agent would have. */
  async function deployed(deploymentId: string): Promise<void> {
    expect(
      await fixture.app
        .get(DeploymentPipeline)
        .run(fixture.organizationId, deploymentId, () => NOW),
    ).toBe('wait');
    await admin.query(
      "UPDATE deployments SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
      [deploymentId, new Date(NOW.getTime() - 1000)],
    );
  }
  /** A state report of the node, every container running and managed. */
  const reportOf = (names: readonly string[]) =>
    create(StateReportSchema, {
      containers: names.map((name, index) => ({
        containerId: index.toString(16).padStart(64, 'a'),
        name,
        state: ContainerStatus_State.RUNNING,
        labels: { 'sk.managed': 'true' },
      })),
    });
  const untracked = (actor: TenantActor) =>
    fixture.get(`${fixture.root}/nodes/${nodeId}/untracked-containers`, actor);
  const confirmation = (actor: TenantActor, container: string, name: string) =>
    fixture.post(`${fixture.root}/confirmations`, actor, {
      action: 'node.container.remove',
      target: `${nodeId}/${container}`,
      name,
    });
  const remove = (actor: TenantActor, container: string, token: string) =>
    fixture.post(
      `${fixture.root}/nodes/${nodeId}/untracked-containers/${container}/remove`,
      actor,
      { confirmation: token },
    );

  it('lists the containers no placed replica matches, and removes one on its typed name', async () => {
    const { id } = await createApplication('billing', 'billing.example.com');
    await deployed(await deploy(id));
    const placed = (
      await admin.query<{ container: string }>(
        "SELECT container FROM allocations WHERE application_id = $1 AND state = 'placed'",
        [id],
      )
    ).rows.map((row) => row.container);
    expect(placed).toHaveLength(1);
    const running = placed[0] ?? '';
    // Release 2 was deployed after the backup this database came from: its container still runs.
    const lost = running.replace(/-r1-0$/, '-r2-0');
    expect(lost).not.toBe(running);
    const identity = { organizationId: fixture.organizationId, nodeId, serial: '' };
    const record = (names: readonly string[]) =>
      fixture.app.get(AllocationObservations).record(identity, reportOf(names), NOW);
    await record([running, lost, 'sk-gone-0000000000ff-r1-0', 'sk-postgres']);

    // Only the lost container is untracked: the running one is placed, the others name no
    // application of this organization.
    const listed = (await untracked('admin').expect(200)).body as {
      items: { name: string; application: { id: string }; release: number; replica: string }[];
    };
    expect(
      listed.items.map((item) => [item.name, item.application.id, item.release, item.replica]),
    ).toEqual([[lost, id, 2, '0']]);
    for (const actor of ['member', 'projectAdmin', 'outsider'] as const)
      await untracked(actor).expect(404);
    const changed = await auditLog().findMany({
      where: { action: 'node.unmatched_containers_changed', targetId: nodeId },
    });
    expect(changed.map((event) => [event.actorId, event.metadata])).toEqual([
      [
        nodeId,
        { added: [lost, 'sk-gone-0000000000ff-r1-0', 'sk-postgres'].sort(), gone: [], count: 3 },
      ],
    ]);

    // A confirmation names this container exactly, and only an untracked one.
    await confirmation('admin', lost, 'sk-billing')
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'confirmation_name_mismatch' });
      });
    await confirmation('admin', running, running).expect(404);
    await confirmation('member', lost, lost).expect(404);
    const issued = (await confirmation('admin', lost, lost).expect(201)).body as { token: string };

    // The token is spent on this container only.
    await remove('admin', running, issued.token)
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'container_not_untracked' });
      });
    await remove('admin', lost, 'not a token').expect(400);
    const removed = (await remove('admin', lost, issued.token).expect(202)).body as {
      actionId: string;
    };
    const action = (
      await admin.query<{ kind: string; idempotency_key: string; node_id: string }>(
        'SELECT kind, idempotency_key, node_id FROM agent_actions WHERE id = $1',
        [removed.actionId],
      )
    ).rows[0];
    expect(action).toMatchObject({ kind: 'removeContainer', node_id: nodeId });
    expect(action.idempotency_key).toMatch(/^u:[0-9a-f-]{36}:remove$/);
    const requested = await auditLog().findMany({
      where: { action: 'node.untracked_container_removal_requested', targetId: nodeId },
    });
    expect(requested.map((event) => [event.actorId, event.metadata])).toMatchObject([
      [
        fixture.actors.admin.id,
        { container: lost, applicationId: id, release: 2, actionId: removed.actionId },
      ],
    ]);
    await remove('admin', lost, issued.token).expect(400);

    // Once the server reports it gone, nothing is listed.
    await record([running]);
    expect(((await untracked('admin').expect(200)).body as { items: unknown[] }).items).toEqual([]);
  });

  it('lists nothing of an application while one of its deployments is underway', async () => {
    const { id } = await createApplication('ledger', 'ledger.example.com');
    await deployed(await deploy(id));
    const running =
      (
        await admin.query<{ container: string }>(
          "SELECT container FROM allocations WHERE application_id = $1 AND state = 'placed'",
          [id],
        )
      ).rows[0]?.container ?? '';
    const next = running.replace(/-r1-0$/, '-r2-task');
    const identity = { organizationId: fixture.organizationId, nodeId, serial: '' };
    // Its next deployment runs a release task, which matches no placed replica.
    await deploy(id);
    await fixture.app.get(AllocationObservations).record(identity, reportOf([running, next]), NOW);
    const listed = (await untracked('admin').expect(200)).body as { items: { name: string }[] };
    expect(listed.items.map((item) => item.name)).not.toContain(next);
  });
});

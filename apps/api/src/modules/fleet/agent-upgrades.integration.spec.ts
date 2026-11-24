import { create } from '@bufbuild/protobuf';
import { Client } from 'pg';
import { ActionUpdateSchema, OperationState } from '@shipkeep/proto-ts';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { AgentActions } from './application/agent-actions';
import {
  AgentUpgrades,
  CONTROL_PLANE_VERSION,
  upgradeActionKey,
} from './application/agent-upgrades';
import { AGENT_RELEASES, type AgentRelease, NODE_STORE, type NodeStore } from './application/ports';

const RELEASE: AgentRelease = {
  url: 'https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0/shipkeep-agent_0.2.0_linux_amd64.tar.gz',
  sha256: 'a'.repeat(64),
  bundleJson: new TextEncoder().encode(
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  ),
};

/** ADR 0028: an agent rollout over HTTP, through the queue's runs, against PostgreSQL. */
describe('agent upgrades', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const asked: string[] = [];

  beforeAll(async () => {
    fixture = await tenantHttpFixture([
      { token: CONTROL_PLANE_VERSION, value: '0.2.0' },
      {
        token: AGENT_RELEASES,
        value: {
          find: (version: { text: string }, architecture: string) => {
            asked.push(`${version.text}/${architecture}`);
            return Promise.resolve(RELEASE);
          },
        },
      },
    ]);
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('upgrades each agent in turn, audited, and refuses a second rollout', async () => {
    const heartbeatAt = new Date();
    const nodeId = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-upgrade.example.com', architecture: 'amd64' },
      heartbeatAt,
    });
    const root = `${fixture.root}/agent-upgrades`;
    const before = await fixture.get(root, 'admin').expect(200);
    expect(before.body).toEqual({ version: '0.2.0', pending: [nodeId], rollout: null });
    for (const actor of ['member', 'projectAdmin', 'outsider'] as const) {
      await fixture.get(root, actor).expect(404);
      await fixture.post(root, actor, { version: '0.2.0' }).expect(404);
    }

    await fixture.post(root, 'admin', {}).expect(400);
    await fixture.post(root, 'admin', { version: '0.2.0; rm' }).expect(400);
    const started = await fixture.post(root, 'admin', { version: '0.2.0' }).expect(202);
    const rollout = started.body as { id: string; state: string; nodeIds: string[] };
    expect(rollout).toMatchObject({
      version: '0.2.0',
      state: 'running',
      nodeIds: [nodeId],
      position: 0,
    });
    expect(asked).toEqual(['0.2.0/amd64']);
    const again = await fixture.post(root, 'admin', { version: '0.2.0' }).expect(409);
    expect(JSON.stringify(again.body)).toContain('agent_upgrade_running');

    // The queue's run sends UpgradeAgent with the release, under the rollout's key.
    const upgrades = fixture.app.get(AgentUpgrades);
    const organizationId = fixture.organizationId;
    expect(await upgrades.advance(organizationId, rollout.id, () => heartbeatAt)).toBe(15);
    const action = await fixture.database.runTenant(organizationId, () =>
      fixture.database.client.agentAction.findFirstOrThrow({
        where: { nodeId, idempotencyKey: upgradeActionKey(rollout.id, nodeId) },
      }),
    );
    expect(action).toMatchObject({ kind: 'upgradeAgent', state: 'queued' });

    // The agent reports success, then comes back with the new version.
    const identity = { organizationId, nodeId, serial: '' };
    await fixture.app
      .get(AgentActions)
      .record(
        identity,
        create(ActionUpdateSchema, { actionId: action.id, state: OperationState.SUCCEEDED }),
      );
    const nodes = fixture.app.get<NodeStore>(NODE_STORE);
    await fixture.database.runTenant(organizationId, async () => {
      const node = await nodes.findById(organizationId, nodeId);
      await nodes.updateFacts(organizationId, nodeId, { ...node?.facts, agent_version: '0.2.0' });
    });
    expect(await upgrades.advance(organizationId, rollout.id, () => heartbeatAt)).toBeNull();

    const after = await fixture.get(root, 'admin').expect(200);
    expect(after.body).toMatchObject({
      pending: [],
      rollout: { id: rollout.id, state: 'succeeded', position: 1, failure: null },
    });
    const events = await auditLog().findMany({
      where: { targetType: 'agent_upgrade', targetId: rollout.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((event) => [event.action, event.metadata])).toEqual([
      ['fleet.agent_upgrade.started', { version: '0.2.0', nodeIds: [nodeId] }],
      ['fleet.agent_upgrade.node_upgraded', { nodeId }],
      ['fleet.agent_upgrade.succeeded', { version: '0.2.0' }],
    ]);
    const nothing = await fixture.post(root, 'admin', { version: '0.2.0' }).expect(409);
    expect(JSON.stringify(nothing.body)).toContain('agent_upgrade_not_needed');
  });

  it('keeps one running rollout per organization in the table itself', async () => {
    // The administrative login: the constraint holds whatever the API does.
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const insert = (id: string) =>
        admin.query(
          `INSERT INTO agent_upgrades (id, organization_id, version, state, node_ids, position,
            turn_started_at, created_at, updated_at)
           VALUES ($1, $2, '0.3.0', 'running', ARRAY[$2]::uuid[], 0, now(), now(), now())`,
          [id, fixture.organizationId],
        );
      await insert('0190f5a8-7b1c-7e2d-8f3a-0000000000f1');
      await expect(insert('0190f5a8-7b1c-7e2d-8f3a-0000000000f2')).rejects.toMatchObject({
        code: '23505',
        constraint: 'agent_upgrades_one_running_idx',
      });
      // A rollout that ended leaves room for the next one; a failure needs its reason.
      await expect(
        admin.query(
          `UPDATE agent_upgrades SET state = 'failed', completed_at = now() WHERE version = '0.3.0'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await admin.query(
        `UPDATE agent_upgrades SET state = 'failed', failure_node_id = $1, failure_reason = 'node_busy',
           completed_at = now() WHERE version = '0.3.0'`,
        [fixture.organizationId],
      );
      await insert('0190f5a8-7b1c-7e2d-8f3a-0000000000f3');
      await expect(
        admin.query(
          `INSERT INTO agent_upgrades (id, organization_id, version, state, node_ids, position,
            turn_started_at, created_at, updated_at)
           VALUES ($1, $2, '0.3.0; drop', 'succeeded', ARRAY[$2]::uuid[], 1, now(), now(), now())`,
          ['0190f5a8-7b1c-7e2d-8f3a-0000000000f4', fixture.organizationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await admin.query(`DELETE FROM agent_upgrades WHERE version = '0.3.0'`);
      await admin.end();
    }
  });
});

import { create } from '@bufbuild/protobuf';
import { Client } from 'pg';
import { ActionUpdateSchema, CollectFactsSchema, OperationState } from '@shipkeep/proto-ts';

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
    const first = await enrollTestNode(fixture, {
      name: 'edge-a',
      facts: { hostname: 'edge-a.example.com', architecture: 'amd64' },
      heartbeatAt,
    });
    const second = await enrollTestNode(fixture, {
      name: 'edge-b',
      facts: { hostname: 'edge-b.example.com', architecture: 'amd64' },
      heartbeatAt,
    });
    const root = `${fixture.root}/agent-upgrades`;
    const before = await fixture.get(root, 'admin').expect(200);
    expect(before.body).toMatchObject({ version: '0.2.0', rollout: null });
    expect((before.body as { pending: string[] }).pending.sort()).toEqual([first, second].sort());
    for (const actor of ['member', 'projectAdmin', 'outsider'] as const) {
      await fixture.get(root, actor).expect(404);
      await fixture.post(root, actor, { version: '0.2.0' }).expect(404);
    }

    await fixture.post(root, 'admin', {}).expect(400);
    await fixture.post(root, 'admin', { version: '0.2.0; rm' }).expect(400);
    const started = await fixture.post(root, 'admin', { version: '0.2.0' }).expect(202);
    const rollout = started.body as { id: string; state: string; nodeIds: string[] };
    // In name order: edge-a, then edge-b.
    expect(rollout).toMatchObject({
      version: '0.2.0',
      state: 'running',
      nodeIds: [first, second],
      position: 0,
    });
    expect(asked).toEqual(['0.2.0/amd64']);
    const again = await fixture.post(root, 'admin', { version: '0.2.0' }).expect(409);
    expect(JSON.stringify(again.body)).toContain('agent_upgrade_running');

    const upgrades = fixture.app.get(AgentUpgrades);
    const actions = fixture.app.get(AgentActions);
    const organizationId = fixture.organizationId;
    const clock = () => heartbeatAt;
    const upgradeActions = () =>
      fixture.database.runTenant(organizationId, () =>
        fixture.database.client.agentAction.findMany({
          where: { kind: 'upgradeAgent' },
          orderBy: { id: 'asc' },
        }),
      );
    const finish = async (nodeId: string, actionId: string) => {
      await actions.record(
        { organizationId, nodeId, serial: '' },
        create(ActionUpdateSchema, { actionId, state: OperationState.SUCCEEDED }),
      );
    };
    const nodes = fixture.app.get<NodeStore>(NODE_STORE);
    const report = (nodeId: string) =>
      fixture.database.runTenant(organizationId, async () => {
        const node = await nodes.findById(organizationId, nodeId);
        await nodes.updateFacts(organizationId, nodeId, { ...node?.facts, agent_version: '0.2.0' });
      });

    // Another action of edge-a is unfinished, as during a deployment: its turn waits.
    const other = await actions.enqueue({
      organizationId,
      nodeId: first,
      idempotencyKey: 'facts:before-upgrade',
      action: { case: 'collectFacts', value: create(CollectFactsSchema, {}) },
      deadline: new Date(Date.now() + 60_000),
      actor: { kind: 'system' },
    });
    expect(await upgrades.advance(organizationId, rollout.id, clock)).toBe(15);
    expect(await upgradeActions()).toEqual([]);
    // Nor can an exclusive admission go past it, whatever the rollout read before.
    await expect(
      actions.enqueue({
        organizationId,
        nodeId: first,
        idempotencyKey: upgradeActionKey(rollout.id, first),
        action: { case: 'collectFacts', value: create(CollectFactsSchema, {}) },
        deadline: new Date(Date.now() + 60_000),
        actor: { kind: 'system' },
        exclusive: true,
      }),
    ).rejects.toMatchObject({ code: 'node_busy' });
    await finish(first, other.id);

    // edge-a's turn: one UpgradeAgent, under the rollout's key; nothing for edge-b yet.
    expect(await upgrades.advance(organizationId, rollout.id, clock)).toBe(15);
    const sent = await upgradeActions();
    const toFirst = sent.at(0);
    const rest = sent.slice(1);
    expect(rest).toEqual([]);
    expect(toFirst).toMatchObject({
      nodeId: first,
      idempotencyKey: upgradeActionKey(rollout.id, first),
      state: 'queued',
    });
    expect(await upgrades.advance(organizationId, rollout.id, clock)).toBe(15);
    expect(await upgradeActions()).toHaveLength(1);

    // edge-a reports success, then comes back with the new version: edge-b's turn comes.
    await finish(first, toFirst?.id ?? '');
    await report(first);
    expect(await upgrades.advance(organizationId, rollout.id, clock)).toBe(15);
    const both = await upgradeActions();
    expect(both.map((action) => action.nodeId)).toEqual([first, second]);
    await finish(second, both.at(1)?.id ?? '');
    await report(second);
    expect(await upgrades.advance(organizationId, rollout.id, clock)).toBeNull();

    const after = await fixture.get(root, 'admin').expect(200);
    expect(after.body).toMatchObject({
      pending: [],
      rollout: { id: rollout.id, state: 'succeeded', position: 2, failure: null },
    });
    const events = await auditLog().findMany({
      where: { targetType: 'agent_upgrade', targetId: rollout.id },
      orderBy: { id: 'asc' },
    });
    expect(events.map((event) => [event.action, event.metadata])).toEqual([
      ['fleet.agent_upgrade.started', { version: '0.2.0', nodeIds: [first, second] }],
      ['fleet.agent_upgrade.node_upgraded', { nodeId: first }],
      ['fleet.agent_upgrade.node_upgraded', { nodeId: second }],
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

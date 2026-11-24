import type { DomainEvent } from '@shipkeep/domain';
import type { ActionRequest } from '@shipkeep/proto-ts';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext } from '../../identity/application/resource-security-context';
import type { TenantAccess } from '../../organizations/application/tenant-access';
import type { AgentActionRecord, AgentActionState } from '../domain/agent-action';
import type { AgentUpgradeRecord } from '../domain/agent-upgrade';
import { UPGRADE_TIMINGS } from '../domain/agent-upgrade';
import type { NodeRecord } from '../domain/node';

import type { AgentActions } from './agent-actions';
import { AgentUpgrades, upgradeActionKey } from './agent-upgrades';
import { MemoryNodeStore, RecordingTransaction } from './fakes.spec-helpers';
import type {
  AgentActionStore,
  AgentRelease,
  AgentReleases,
  AgentUpgradeChange,
  AgentUpgradeStore,
} from './ports';

/** The tests' clock: servers heartbeat at it, so they read as connected. */
const START = new Date('2026-11-24T10:00:00Z');
const ORG = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const USER = '0190f5a8-7b1c-7e2d-8f3a-0123456789ac';
const context: ResourceSecurityContext = {
  userId: USER,
  ip: '203.0.113.7',
} as ResourceSecurityContext;
const RELEASE: AgentRelease = {
  url: 'https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0/shipkeep-agent_0.2.0_linux_amd64.tar.gz',
  sha256: 'a'.repeat(64),
  bundleJson: new TextEncoder().encode(
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  ),
};

class MemoryUpgradeStore implements AgentUpgradeStore {
  readonly rows: AgentUpgradeRecord[] = [];
  insert(record: AgentUpgradeRecord): Promise<boolean> {
    if (
      this.rows.some(
        (row) => row.organizationId === record.organizationId && row.state === 'running',
      )
    )
      return Promise.resolve(false);
    this.rows.push(record);
    return Promise.resolve(true);
  }
  findById(organizationId: string, id: string) {
    return Promise.resolve(
      this.rows.find((row) => row.organizationId === organizationId && row.id === id),
    );
  }
  latest(organizationId: string) {
    return Promise.resolve(this.rows.filter((row) => row.organizationId === organizationId).at(-1));
  }
  findRunning(organizationId: string) {
    return Promise.resolve(
      this.rows.find((row) => row.organizationId === organizationId && row.state === 'running'),
    );
  }
  update(
    organizationId: string,
    id: string,
    expected: Pick<AgentUpgradeRecord, 'position' | 'actionId'>,
    change: AgentUpgradeChange,
  ) {
    const index = this.rows.findIndex(
      (row) =>
        row.organizationId === organizationId &&
        row.id === id &&
        row.state === 'running' &&
        row.position === expected.position &&
        row.actionId === expected.actionId,
    );
    const row = index >= 0 ? this.rows.at(index) : undefined;
    if (!row) return Promise.resolve(undefined);
    const updated = { ...row, ...change };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }
}

/** The action queue as the rollout sees it: what was enqueued, and each action's state. */
class Actions {
  readonly sent: {
    nodeId: string;
    key: string;
    action: ActionRequest['action'];
    deadline: Date;
  }[] = [];
  readonly records = new Map<string, AgentActionRecord>();
  readonly busy = new Set<string>();
  readonly queue = {
    enqueue: (input: {
      nodeId: string;
      idempotencyKey: string;
      action: ActionRequest['action'];
      deadline: Date;
    }) => {
      this.sent.push({
        nodeId: input.nodeId,
        key: input.idempotencyKey,
        action: input.action,
        deadline: input.deadline,
      });
      const id = `0190f5a8-7b1c-7e2d-8f3a-${String(this.sent.length).padStart(12, '0')}`;
      this.records.set(input.idempotencyKey, {
        id,
        state: 'queued',
        error: null,
        result: null,
        completedAt: null,
      } as AgentActionRecord);
      return Promise.resolve({ id, created: true });
    },
  } as unknown as AgentActions;
  readonly store = {
    findByKey: (_organizationId: string, _nodeId: string, key: string) =>
      Promise.resolve(this.records.get(key)),
    hasUnfinished: (_organizationId: string, nodeId: string) =>
      Promise.resolve(this.busy.has(nodeId)),
  } as unknown as AgentActionStore;
  finish(key: string, state: AgentActionState, at: Date, error: string | null = null) {
    const record = this.records.get(key);
    if (!record) throw new Error(`no action ${key}`);
    this.records.set(key, { ...record, state, error, completedAt: at });
  }
}

function setup(options: { version?: string; release?: AgentRelease | null } = {}) {
  const nodes = new MemoryNodeStore();
  const upgrades = new MemoryUpgradeStore();
  const actions = new Actions();
  const published: DomainEvent[] = [];
  const woken: [string, number | undefined][] = [];
  const asked: string[] = [];
  const releases: AgentReleases = {
    find: (version, architecture) => {
      asked.push(`${version.text}/${architecture}`);
      return Promise.resolve(options.release === undefined ? RELEASE : options.release);
    },
  };
  const service = new AgentUpgrades(
    options.version ?? '0.2.0',
    upgrades,
    nodes,
    actions.store,
    releases,
    new RecordingTransaction(),
    {
      wake: (_organizationId, id, delay) => {
        woken.push([id, delay]);
        return Promise.resolve();
      },
    },
    actions.queue,
    {
      run: (_context: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as AccountMutationAuthority,
    { require: () => Promise.resolve() } as unknown as TenantAccess,
    {
      publish: (batch: DomainEvent[]) => {
        published.push(...batch);
        return Promise.resolve();
      },
    } as unknown as DomainEventBus,
  );
  const node = (
    id: string,
    name: string,
    facts: Record<string, string>,
    status: NodeRecord['status'] = 'ready',
  ) => {
    nodes.nodes.push({
      id,
      organizationId: ORG,
      name,
      status,
      labels: {},
      facts,
      publicAddresses: [],
      leaseEpoch: 1,
      createdAt: new Date(0),
      lastHeartbeatAt: START,
    });
  };
  const report = (id: string, facts: Record<string, string>, lastHeartbeatAt = START) => {
    const index = nodes.nodes.findIndex((candidate) => candidate.id === id);
    const current = index >= 0 ? nodes.nodes.at(index) : undefined;
    if (current)
      nodes.nodes[index] = { ...current, facts: { ...current.facts, ...facts }, lastHeartbeatAt };
  };
  return { service, nodes, upgrades, actions, published, woken, asked, node, report };
}

const A = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const B = '0190f5a8-7b1c-7e2d-8f3a-00000000000b';
const C = '0190f5a8-7b1c-7e2d-8f3a-00000000000c';

describe('AgentUpgrades', () => {
  it('starts a rollout of the servers on an older release, by name', async () => {
    const t = setup();
    t.node(B, 'edge-b', { agent_version: '0.1.0', architecture: 'arm64' });
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(C, 'edge-c', { agent_version: '0.2.0', architecture: 'amd64' });
    const started = await t.service.start(context, ORG, '0.2.0', new Date('2026-11-24T10:00:00Z'));
    expect(started).toMatchObject({
      version: '0.2.0',
      state: 'running',
      nodeIds: [A, B],
      position: 0,
    });
    expect(t.asked.sort()).toEqual(['0.2.0/amd64', '0.2.0/arm64']);
    expect(t.published.map((event) => [event.type, event.actor, event.payload])).toEqual([
      [
        'fleet.agent_upgrade.started',
        { kind: 'user', id: USER, ip: '203.0.113.7' },
        { version: '0.2.0', nodeIds: [A, B] },
      ],
    ]);
    expect(t.woken).toEqual([[started.id, undefined]]);
  });

  it('refuses a development build, nothing to do, a second rollout and a release GitHub lacks', async () => {
    const dev = setup({ version: 'dev' });
    dev.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    await expect(dev.service.start(context, ORG, '0.2.0')).rejects.toMatchObject({
      code: 'agent_upgrade_unavailable',
    });

    const changed = setup({ version: '0.3.0' });
    changed.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    await expect(changed.service.start(context, ORG, '0.2.0')).rejects.toMatchObject({
      code: 'agent_upgrade_version_changed',
    });

    const done = setup();
    done.node(A, 'edge-a', { agent_version: '0.2.0', architecture: 'amd64' });
    done.node(B, 'edge-b', { agent_version: 'dev', architecture: 'amd64' });
    await expect(done.service.start(context, ORG, '0.2.0')).rejects.toMatchObject({
      code: 'agent_upgrade_not_needed',
    });

    const twice = setup();
    twice.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    await twice.service.start(context, ORG, '0.2.0');
    await expect(twice.service.start(context, ORG, '0.2.0')).rejects.toMatchObject({
      code: 'agent_upgrade_running',
    });

    const missing = setup({ release: null });
    missing.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    await expect(missing.service.start(context, ORG, '0.2.0')).rejects.toMatchObject({
      code: 'agent_release_unavailable',
    });
    for (const t of [dev, changed, done, missing]) {
      expect(t.upgrades.rows).toEqual([]);
      expect(t.published).toEqual([]);
    }
  });

  it('upgrades one server at a time, waiting for each to come back with the new version', async () => {
    const t = setup();
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(B, 'edge-b', { agent_version: '0.1.0', architecture: 'amd64' });
    const start = new Date('2026-11-24T10:00:00Z');
    const { id } = await t.service.start(context, ORG, '0.2.0', start);
    let now = start;
    const clock = () => now;

    // A's turn: the action is sent with the release, and nothing goes to B yet.
    expect(await t.service.advance(ORG, id, clock)).toBe(UPGRADE_TIMINGS.pollSeconds);
    expect(t.actions.sent).toHaveLength(1);
    const first = t.actions.sent.at(0);
    expect(first?.nodeId).toBe(A);
    expect(first?.key).toBe(upgradeActionKey(id, A));
    expect(first?.deadline).toEqual(new Date(start.getTime() + UPGRADE_TIMINGS.actionMs));
    expect(first?.action.case).toBe('upgradeAgent');
    expect(first?.action.value).toMatchObject({
      version: '0.2.0',
      url: RELEASE.url,
      sha256: RELEASE.sha256,
      cosignBundle: { bundleJson: RELEASE.bundleJson },
    });
    // Run again before the action ended: it waits, and sends nothing twice.
    expect(await t.service.advance(ORG, id, clock)).toBe(UPGRADE_TIMINGS.pollSeconds);
    expect(t.actions.sent).toHaveLength(1);

    // The action succeeded; the agent restarts and comes back with the new version.
    now = new Date(start.getTime() + 60_000);
    t.actions.finish(upgradeActionKey(id, A), 'succeeded', now);
    expect(await t.service.advance(ORG, id, clock)).toBe(UPGRADE_TIMINGS.pollSeconds);
    t.report(A, { agent_version: '0.2.0' }, now);
    t.report(B, {}, now);
    // A is done, and B's turn sends its action at once.
    expect(await t.service.advance(ORG, id, clock)).toBe(UPGRADE_TIMINGS.pollSeconds);
    expect(t.actions.sent.map((sent) => sent.nodeId)).toEqual([A, B]);

    t.actions.finish(upgradeActionKey(id, B), 'succeeded', now);
    t.report(B, { agent_version: '0.2.0' }, now);
    expect(await t.service.advance(ORG, id, clock)).toBeNull();
    expect(t.upgrades.rows[0]).toMatchObject({
      state: 'succeeded',
      position: 2,
      completedAt: now,
      failure: null,
    });
    expect(t.published.map((event) => [event.type, event.actor.kind, event.payload])).toEqual([
      ['fleet.agent_upgrade.started', 'user', { version: '0.2.0', nodeIds: [A, B] }],
      ['fleet.agent_upgrade.node_upgraded', 'system', { nodeId: A }],
      ['fleet.agent_upgrade.node_upgraded', 'system', { nodeId: B }],
      ['fleet.agent_upgrade.succeeded', 'system', { version: '0.2.0' }],
    ]);
    // An ended rollout does nothing more.
    expect(await t.service.advance(ORG, id, clock)).toBeNull();
    expect(t.actions.sent).toHaveLength(2);
  });

  it('stops at the first failure, with the reason the agent gave', async () => {
    const t = setup();
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(B, 'edge-b', { agent_version: '0.1.0', architecture: 'amd64' });
    const now = new Date('2026-11-24T10:00:00Z');
    const { id } = await t.service.start(context, ORG, '0.2.0', now);
    await t.service.advance(ORG, id, () => now);
    t.actions.finish(upgradeActionKey(id, A), 'compensated', now, 'registry refused the pull');
    expect(await t.service.advance(ORG, id, () => now)).toBeNull();
    expect(t.upgrades.rows[0]).toMatchObject({
      state: 'failed',
      position: 0,
      failure: { nodeId: A, reason: 'action_failed', actionReason: 'registry_denied' },
    });
    expect(t.published.at(-1)?.type).toBe('fleet.agent_upgrade.failed');
    expect(t.published.at(-1)?.payload).toEqual({
      version: '0.2.0',
      nodeId: A,
      reason: 'action_failed',
      actionReason: 'registry_denied',
    });
    expect(t.actions.sent.map((sent) => sent.nodeId)).toEqual([A]);
  });

  it('skips a server that is gone or already upgraded, and waits while another action runs', async () => {
    const t = setup();
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(B, 'edge-b', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(C, 'edge-c', { agent_version: '0.1.0', architecture: 'amd64' });
    const now = new Date('2026-11-24T10:00:00Z');
    const { id } = await t.service.start(context, ORG, '0.2.0', now);
    t.nodes.nodes.splice(
      0,
      t.nodes.nodes.length,
      ...t.nodes.nodes.map((node): NodeRecord =>
        node.id === A
          ? { ...node, status: 'removed' }
          : node.id === B
            ? { ...node, facts: { ...node.facts, agent_version: '0.2.0' } }
            : node,
      ),
    );
    t.actions.busy.add(C);
    expect(await t.service.advance(ORG, id, () => now)).toBe(UPGRADE_TIMINGS.pollSeconds);
    expect(t.actions.sent).toEqual([]);
    expect(t.upgrades.rows[0]?.position).toBe(2);
    expect(t.published.slice(1).map((event) => [event.type, event.payload])).toEqual([
      ['fleet.agent_upgrade.node_skipped', { nodeId: A }],
      ['fleet.agent_upgrade.node_skipped', { nodeId: B }],
    ]);
    t.actions.busy.delete(C);
    await t.service.advance(ORG, id, () => now);
    expect(t.actions.sent.map((sent) => sent.nodeId)).toEqual([C]);
  });

  it('stops when the release cannot be read at the turn of a server', async () => {
    const t = setup();
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    const now = new Date('2026-11-24T10:00:00Z');
    const { id } = await t.service.start(context, ORG, '0.2.0', now);
    const unavailable = new AgentUpgrades(
      '0.2.0',
      t.upgrades,
      t.nodes,
      t.actions.store,
      { find: () => Promise.resolve(null) },
      new RecordingTransaction(),
      { wake: () => Promise.resolve() },
      t.actions.queue,
      {
        run: (_c: unknown, work: () => Promise<unknown>) => work(),
      } as unknown as AccountMutationAuthority,
      { require: () => Promise.resolve() } as unknown as TenantAccess,
      {
        publish: (batch: DomainEvent[]) => (t.published.push(...batch), Promise.resolve()),
      } as unknown as DomainEventBus,
    );
    expect(await unavailable.advance(ORG, id, () => now)).toBeNull();
    expect(t.actions.sent).toEqual([]);
    expect(t.upgrades.rows[0]?.failure).toEqual({
      nodeId: A,
      reason: 'release_unavailable',
      actionReason: null,
    });
  });

  it('shows the target, the servers on an older release and the newest rollout', async () => {
    const t = setup();
    t.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    t.node(B, 'edge-b', { agent_version: '0.2.0', architecture: 'amd64' });
    expect(await t.service.overview(context, ORG)).toEqual({
      version: '0.2.0',
      pending: [A],
      rollout: null,
    });
    const started = await t.service.start(context, ORG, '0.2.0');
    expect((await t.service.overview(context, ORG)).rollout?.id).toBe(started.id);
    const dev = setup({ version: 'dev' });
    dev.node(A, 'edge-a', { agent_version: '0.1.0', architecture: 'amd64' });
    expect(await dev.service.overview(context, ORG)).toEqual({
      version: null,
      pending: [],
      rollout: null,
    });
  });
});

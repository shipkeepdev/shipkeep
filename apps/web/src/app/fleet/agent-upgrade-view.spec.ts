import { FR } from '../ui/fr';

import { agentUpgradeView, startRefusal } from './agent-upgrade-view';
import type { AgentUpgrade, AgentUpgradeOverview } from './fleet-api';

const A = '0190f5a8-7b1c-7e2d-8f3a-00000000000a';
const B = '0190f5a8-7b1c-7e2d-8f3a-00000000000b';
const C = '0190f5a8-7b1c-7e2d-8f3a-00000000000c';
const names = new Map([
  [A, 'edge-a'],
  [B, 'edge-b'],
]);
const rollout = (changes: Partial<AgentUpgrade>): AgentUpgrade => ({
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000f1',
  version: '0.2.0',
  state: 'running',
  nodeIds: [A, B, C],
  position: 1,
  failure: null,
  createdAt: '2026-11-24T10:00:00Z',
  updatedAt: '2026-11-24T10:05:00Z',
  completedAt: null,
  ...changes,
});
const overview = (changes: Partial<AgentUpgradeOverview>): AgentUpgradeOverview => ({
  version: '0.2.0',
  pending: [],
  rollout: null,
  ...changes,
});

describe('agentUpgradeView', () => {
  it('says nothing on a development build, without data, or with nothing to upgrade', () => {
    expect(agentUpgradeView(null, names)).toEqual({ kind: 'hidden' });
    expect(agentUpgradeView(overview({ version: null, pending: [A] }), names)).toEqual({
      kind: 'hidden',
    });
    expect(agentUpgradeView(overview({}), names)).toEqual({ kind: 'hidden' });
    expect(
      agentUpgradeView(overview({ rollout: rollout({ state: 'succeeded', position: 3 }) }), names),
    ).toEqual({ kind: 'hidden' });
  });

  it('counts the servers on an older release', () => {
    expect(agentUpgradeView(overview({ pending: [A, B] }), names)).toEqual({
      kind: 'pending',
      version: '0.2.0',
      pending: 2,
    });
  });

  it("shows a running rollout's turn, by name, falling back to the id", () => {
    expect(agentUpgradeView(overview({ pending: [B, C], rollout: rollout({}) }), names)).toEqual({
      kind: 'running',
      version: '0.2.0',
      position: 2,
      total: 3,
      current: 'edge-b',
      servers: [
        { id: A, name: 'edge-a', turn: 'done' },
        { id: B, name: 'edge-b', turn: 'current' },
        { id: C, name: C, turn: 'waiting' },
      ],
    });
  });

  it('says where and why the last rollout stopped while servers still wait', () => {
    const failed = rollout({
      state: 'failed',
      failure: { nodeId: B, reason: 'action_failed', actionReason: 'registry_denied' },
      completedAt: '2026-11-24T10:06:00Z',
    });
    expect(agentUpgradeView(overview({ pending: [B, C], rollout: failed }), names)).toMatchObject({
      kind: 'failed',
      version: '0.2.0',
      pending: 2,
      server: 'edge-b',
      sentence: 'The agent of {name} refused or failed the upgrade.',
      detail: 'registry refused the pull',
      servers: [{ turn: 'done' }, { turn: 'stopped' }, { turn: 'waiting' }],
    });
    // Once no server waits any more, an old failure is not news.
    expect(agentUpgradeView(overview({ rollout: failed }), names)).toEqual({ kind: 'hidden' });
  });

  it('has a translated sentence for every reason a rollout stops', () => {
    for (const reason of [
      'node_unavailable',
      'node_busy',
      'release_unavailable',
      'action_failed',
      'rolled_back',
      'not_confirmed',
    ] as const) {
      const view = agentUpgradeView(
        overview({
          pending: [B],
          rollout: rollout({ state: 'failed', failure: { nodeId: B, reason, actionReason: null } }),
        }),
        names,
      );
      if (view.kind !== 'failed') throw new Error(reason);
      expect(view.detail).toBeNull();
      expect(FR[view.sentence], reason).toBeTruthy();
    }
  });

  it('explains each refusal of a start, in French too', () => {
    for (const code of [
      'agent_upgrade_running',
      'agent_upgrade_not_needed',
      'agent_upgrade_version_changed',
      'agent_release_unavailable',
      'agent_upgrade_unavailable',
      'agent_upgrade_too_many',
    ]) {
      const text = startRefusal(code);
      expect(text, code).toBeTruthy();
      expect(FR[text ?? ''], code).toBeTruthy();
    }
    expect(startRefusal('node_public_addresses_changed')).toBeNull();
    expect(startRefusal(undefined)).toBeNull();
  });
});

import {
  agentArchive,
  type AgentUpgradeRecord,
  compareVersions,
  nextUpgradeStep,
  parseReleaseVersion,
  releaseFile,
  type ReleaseVersion,
  upgradeCandidates,
  UPGRADE_TIMINGS,
  type UpgradeActionView,
  type UpgradeNodeView,
} from './agent-upgrade';

function version(text: string): ReleaseVersion {
  const parsed = parseReleaseVersion(text);
  if (!parsed) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('release versions', () => {
  it('reads release versions as the agent does', () => {
    expect(parseReleaseVersion('0.1.0-alpha.3')).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: ['alpha', '3'],
      text: '0.1.0-alpha.3',
    });
    expect(parseReleaseVersion('12.0.999999999')?.patch).toBe(999_999_999);
  });

  it('refuses anything else, as the agent does', () => {
    for (const text of [
      'dev',
      '',
      'v0.1.0',
      '0.1',
      '01.0.0',
      '0.01.0',
      '0.1.0-',
      '0.1.0-alpha..1',
      '0.1.0-01',
      '0.1.0+build',
      '0.1.0 ',
      '0.1.0\n',
      '0.1.0-al/pha',
      '1234567890.0.0',
      `0.1.0-${'a'.repeat(60)}`,
      42,
      null,
      undefined,
      { text: '0.1.0' },
    ])
      expect(parseReleaseVersion(text), JSON.stringify(text)).toBeNull();
  });

  it('orders versions by semantic versioning precedence', () => {
    const ordered = [
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-alpha.2',
      '0.1.0-alpha.10',
      '0.1.0-alpha.beta',
      '0.1.0-beta',
      '0.1.0-beta.2',
      '0.1.0-rc.1',
      '0.1.0',
      '0.1.1',
      '0.2.0',
      '0.10.0',
      '1.0.0',
    ];
    for (let i = 0; i < ordered.length; i++)
      for (let j = 0; j < ordered.length; j++)
        expect(
          compareVersions(version(ordered[i] ?? ''), version(ordered[j] ?? '')),
          `${ordered[i]} vs ${ordered[j]}`,
        ).toBe(Math.sign(i - j));
  });

  it('places a release where release.yml publishes it', () => {
    expect(agentArchive(version('0.2.0-alpha.1'), 'arm64')).toEqual({
      name: 'shipkeep-agent_0.2.0-alpha.1_linux_arm64.tar.gz',
      url: 'https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0-alpha.1/shipkeep-agent_0.2.0-alpha.1_linux_arm64.tar.gz',
    });
    expect(releaseFile(version('0.2.0'), 'checksums.txt')).toBe(
      'https://github.com/shipkeepdev/shipkeep/releases/download/v0.2.0/checksums.txt',
    );
  });
});

describe('upgrade candidates', () => {
  it('lists the servers on an older release, on a released architecture', () => {
    const node = (name: string, facts: Record<string, unknown>, status = 'ready' as const) => ({
      name,
      status,
      facts,
    });
    const nodes = [
      node('older', { agent_version: '0.1.0', architecture: 'amd64' }),
      node('prerelease', { agent_version: '0.2.0-rc.1', architecture: 'arm64' }),
      node('down-but-older', { agent_version: '0.1.0', architecture: 'amd64' }, 'down' as never),
      node('same', { agent_version: '0.2.0', architecture: 'amd64' }),
      node('newer', { agent_version: '0.3.0', architecture: 'amd64' }),
      node('dev', { agent_version: 'dev', architecture: 'amd64' }),
      node('no version', { architecture: 'amd64' }),
      node('other architecture', { agent_version: '0.1.0', architecture: 'riscv64' }),
      node('removed', { agent_version: '0.1.0', architecture: 'amd64' }, 'removed' as never),
    ];
    expect(upgradeCandidates(version('0.2.0'), nodes).map((candidate) => candidate.name)).toEqual([
      'older',
      'prerelease',
      'down-but-older',
    ]);
  });
});

describe('the next step of a rollout', () => {
  const start = new Date('2026-11-24T10:00:00Z');
  const at = (ms: number) => new Date(start.getTime() + ms);
  const upgrade: AgentUpgradeRecord = {
    id: '0190f5a8-7b1c-7e2d-8f3a-0123456789a1',
    organizationId: '0190f5a8-7b1c-7e2d-8f3a-0123456789a2',
    version: '0.2.0',
    state: 'running',
    nodeIds: ['0190f5a8-7b1c-7e2d-8f3a-0123456789a3', '0190f5a8-7b1c-7e2d-8f3a-0123456789a4'],
    position: 0,
    actionId: null,
    turnStartedAt: start,
    failure: null,
    requestedBy: null,
    createdAt: start,
    updatedAt: start,
    completedAt: null,
  };
  const node: UpgradeNodeView = {
    status: 'ready',
    agentVersion: '0.1.0',
    architecture: 'amd64',
    lastHeartbeatAt: start,
    busy: false,
  };
  const sent: UpgradeActionView = { state: 'running', reason: null, completedAt: null };
  const succeeded: UpgradeActionView = {
    state: 'succeeded',
    reason: null,
    completedAt: at(60_000),
  };
  const step = (
    changes: { node?: Partial<UpgradeNodeView> | null; action?: UpgradeActionView; now?: Date },
    record: Partial<AgentUpgradeRecord> = {},
  ) =>
    nextUpgradeStep({
      upgrade: { ...upgrade, ...record },
      node: changes.node === null ? undefined : { ...node, ...changes.node },
      action: changes.action,
      now: changes.now ?? start,
    });
  const wait = { kind: 'wait', seconds: UPGRADE_TIMINGS.pollSeconds };

  it('sends the upgrade to a connected, idle server on an older release', () => {
    expect(step({})).toEqual({ kind: 'send', architecture: 'amd64' });
    expect(step({ node: { architecture: 'arm64' } })).toEqual({
      kind: 'send',
      architecture: 'arm64',
    });
  });

  it('finishes once every server had its turn', () => {
    expect(step({}, { position: 2 })).toEqual({ kind: 'finish' });
  });

  it('skips a server that is gone, already there, or cannot take a release', () => {
    for (const changes of [
      { node: null },
      { node: { status: 'removed' as const } },
      { node: { agentVersion: '0.2.0' } },
      { node: { agentVersion: '0.3.0' } },
      { node: { agentVersion: 'dev' } },
      { node: { agentVersion: '0.2.0\n' } },
      { node: { architecture: 'riscv64' } },
    ])
      expect(step(changes), JSON.stringify(changes)).toEqual({ kind: 'skip' });
  });

  it('waits for a server that is not connected, then stops the rollout', () => {
    for (const status of ['suspect', 'down', 'enrolling', 'draining'] as const) {
      expect(step({ node: { status }, now: at(UPGRADE_TIMINGS.unavailableMs - 1) })).toEqual(wait);
      expect(step({ node: { status }, now: at(UPGRADE_TIMINGS.unavailableMs) })).toEqual({
        kind: 'fail',
        reason: 'node_unavailable',
        actionReason: null,
      });
    }
  });

  it('never sends while another action runs on the server, and gives up after a while', () => {
    expect(step({ node: { busy: true }, now: at(UPGRADE_TIMINGS.busyMs - 1) })).toEqual(wait);
    expect(step({ node: { busy: true }, now: at(UPGRADE_TIMINGS.busyMs) })).toEqual({
      kind: 'fail',
      reason: 'node_busy',
      actionReason: null,
    });
  });

  it('waits for the action, and stops when it did not succeed, with its reason', () => {
    for (const state of ['queued', 'pending', 'running', 'compensating'] as const)
      expect(step({ action: { ...sent, state } })).toEqual(wait);
    for (const state of ['failed', 'compensated', 'cancelled', 'expired'] as const)
      expect(step({ action: { state, reason: 'deadline_exceeded', completedAt: at(1) } })).toEqual({
        kind: 'fail',
        reason: 'action_failed',
        actionReason: 'deadline_exceeded',
      });
  });

  it('stops when the action never ends because the server never came back', () => {
    const deadline = UPGRADE_TIMINGS.actionMs + UPGRADE_TIMINGS.unavailableMs;
    expect(step({ action: sent, node: { status: 'down' }, now: at(deadline - 1) })).toEqual(wait);
    expect(step({ action: sent, node: { status: 'down' }, now: at(deadline) })).toEqual({
      kind: 'fail',
      reason: 'not_confirmed',
      actionReason: null,
    });
  });

  it('moves on once the server reports the new version', () => {
    expect(step({ action: succeeded, node: { agentVersion: '0.2.0' } })).toEqual({ kind: 'done' });
  });

  it('waits for the new version while the previous binary may still run', () => {
    const late = at(60_000 + UPGRADE_TIMINGS.previousStopsMs - 1);
    expect(step({ action: succeeded, node: { lastHeartbeatAt: late }, now: late })).toEqual(wait);
    // The agent restarting reads as suspect or down meanwhile.
    expect(step({ action: succeeded, node: { status: 'down' }, now: at(600_000) })).toEqual(wait);
  });

  it('sees a rollback: a later heartbeat still on the previous version', () => {
    const later = at(60_000 + UPGRADE_TIMINGS.previousStopsMs);
    expect(step({ action: succeeded, node: { lastHeartbeatAt: later }, now: later })).toEqual({
      kind: 'fail',
      reason: 'rolled_back',
      actionReason: null,
    });
  });

  it('stops when the new version never shows up', () => {
    const silent = { lastHeartbeatAt: start, status: 'down' as const };
    expect(
      step({ action: succeeded, node: silent, now: at(60_000 + UPGRADE_TIMINGS.confirmMs - 1) }),
    ).toEqual(wait);
    expect(
      step({ action: succeeded, node: silent, now: at(60_000 + UPGRADE_TIMINGS.confirmMs) }),
    ).toEqual({ kind: 'fail', reason: 'not_confirmed', actionReason: null });
  });
});

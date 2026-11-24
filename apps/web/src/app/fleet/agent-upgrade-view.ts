import { actionReasonLabel } from '../delivery/agent-action-rows';

import type { AgentUpgrade, AgentUpgradeOverview } from './fleet-api';

/** Where a server stands in a rollout. */
export type UpgradeTurn = 'done' | 'current' | 'waiting' | 'stopped';

export interface UpgradeServer {
  readonly id: string;
  readonly name: string;
  readonly turn: UpgradeTurn;
}

/** What the Servers page says about agent upgrades. Texts are English, for `| t`. */
export type AgentUpgradeView =
  /** A development build, nothing to upgrade, or nothing loaded: the page says nothing. */
  | { readonly kind: 'hidden' }
  | { readonly kind: 'pending'; readonly version: string; readonly pending: number }
  | {
      readonly kind: 'running';
      readonly version: string;
      /** 1-based. */
      readonly position: number;
      readonly total: number;
      readonly current: string;
      readonly servers: readonly UpgradeServer[];
    }
  | {
      readonly kind: 'failed';
      readonly version: string;
      readonly pending: number;
      readonly server: string;
      /** Why the rollout stopped, with `{name}` for the server. */
      readonly sentence: string;
      /** The agent's own reason, when it gave one. */
      readonly detail: string | null;
      readonly servers: readonly UpgradeServer[];
    };

/** One sentence per reason a rollout stops (SPEC, agent upgrades). */
const STOPPED: Readonly<Record<NonNullable<AgentUpgrade['failure']>['reason'], string>> = {
  node_unavailable: '{name} was not connected when its turn came.',
  node_busy: 'Another action, such as a deployment, kept running on {name}.',
  release_unavailable:
    'The release could not be read from GitHub. Check that the control plane reaches github.com.',
  action_failed: 'The agent of {name} refused or failed the upgrade.',
  rolled_back: 'The new agent did not start on {name}: the previous version is back.',
  not_confirmed: 'The new agent of {name} did not come back in time.',
};

/** The view of an overview; `names` gives the servers' names, which the rollout only has ids of. */
export function agentUpgradeView(
  overview: AgentUpgradeOverview | null,
  names: ReadonlyMap<string, string>,
): AgentUpgradeView {
  if (!overview?.version) return { kind: 'hidden' };
  const { version, pending, rollout } = overview;
  const name = (id: string) => names.get(id) ?? id;
  const servers = (stopped: boolean): UpgradeServer[] =>
    (rollout?.nodeIds ?? []).map((id, index) => ({
      id,
      name: name(id),
      turn:
        index < (rollout?.position ?? 0)
          ? 'done'
          : index > (rollout?.position ?? 0)
            ? 'waiting'
            : stopped
              ? 'stopped'
              : 'current',
    }));
  if (rollout?.state === 'running') {
    const total = rollout.nodeIds.length;
    const position = Math.min(rollout.position + 1, total);
    return {
      kind: 'running',
      version: rollout.version,
      position,
      total,
      current: name(rollout.nodeIds[position - 1] ?? ''),
      servers: servers(false),
    };
  }
  // A failure is worth showing while servers still wait for the version it did not deliver.
  if (rollout?.state === 'failed' && rollout.failure && pending.length > 0) {
    const reason = rollout.failure.actionReason;
    return {
      kind: 'failed',
      version,
      pending: pending.length,
      server: name(rollout.failure.nodeId),
      sentence: STOPPED[rollout.failure.reason],
      detail: reason ? actionReasonLabel(reason) : null,
      servers: servers(true),
    };
  }
  if (pending.length > 0) return { kind: 'pending', version, pending: pending.length };
  return { kind: 'hidden' };
}

/** What a refused start says, by the API's problem code; null for the page's generic text. */
export function startRefusal(code: string | undefined): string | null {
  switch (code) {
    case 'agent_upgrade_running':
      return 'An agent upgrade is already running.';
    case 'agent_upgrade_not_needed':
      return 'Every agent already runs this version or a later one.';
    case 'agent_upgrade_version_changed':
      return 'The control plane was upgraded meanwhile. Reload the page and try again.';
    case 'agent_release_unavailable':
      return 'The release could not be read from GitHub. Check that the control plane reaches github.com.';
    case 'agent_upgrade_unavailable':
      return 'This control plane is a development build: it has no release to upgrade agents to.';
    case 'agent_upgrade_too_many':
      return 'A rollout upgrades at most 1,000 servers.';
    default:
      return null;
  }
}

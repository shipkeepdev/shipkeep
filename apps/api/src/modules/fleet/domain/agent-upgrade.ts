import type { ActionReason, AgentActionState } from './agent-action';
import type { NodeStatus } from './node';

/**
 * Agent upgrades across an organization's servers, one at a time (ADR 0028, section 2). The
 * control plane names a version and the agent builds the rest; this module decides, for the
 * server whose turn it is, what the rollout does next. It never touches a server itself.
 */

// ---------------------------------------------------------------------------------------------
// Release versions, with the agent's rules (agent/internal/upgrade): MAJOR.MINOR.PATCH, then an
// optional prerelease of dot-separated identifiers, no build metadata, numbers without a leading
// zero and of at most 9 digits.
// ---------------------------------------------------------------------------------------------

const VERSION =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC = /^[0-9]{1,9}$/;

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
  readonly text: string;
}

/** A release version as a tag names it without its `v`; null for anything else, `dev` included. */
export function parseReleaseVersion(text: unknown): ReleaseVersion | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const parts = VERSION.exec(text);
  if (!parts) return null;
  const prerelease = parts[4] ? parts[4].split('.') : [];
  if (prerelease.some((part) => part.length > 1 && part.startsWith('0') && NUMERIC.test(part)))
    return null;
  return {
    major: Number(parts[1]),
    minor: Number(parts[2]),
    patch: Number(parts[3]),
    prerelease,
    text,
  };
}

/** Semantic versioning precedence: negative when `a` comes first. A release follows its prereleases. */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const)
    if (x !== y) return Math.sign(x - y);
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index] ?? '';
    const y = b.prerelease[index] ?? '';
    if (x === y) continue;
    const xNumber = NUMERIC.test(x);
    const yNumber = NUMERIC.test(y);
    if (xNumber && yNumber) return Math.sign(Number(x) - Number(y));
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

/** The architectures releases carry the agent for, as agents report them (Go's GOARCH). */
export const AGENT_ARCHITECTURES = ['amd64', 'arm64'] as const;
export type AgentArchitecture = (typeof AGENT_ARCHITECTURES)[number];

export function isAgentArchitecture(value: unknown): value is AgentArchitecture {
  return AGENT_ARCHITECTURES.some((architecture) => architecture === value);
}

const RELEASES = 'https://github.com/shipkeepdev/shipkeep/releases/download/';

/** The agent archive of a release, named and placed as `release.yml` publishes it. */
export function agentArchive(
  version: ReleaseVersion,
  architecture: AgentArchitecture,
): { readonly name: string; readonly url: string } {
  const name = `shipkeep-agent_${version.text}_linux_${architecture}.tar.gz`;
  return { name, url: `${RELEASES}v${version.text}/${name}` };
}

/** Where a release's other files are: its `checksums.txt` and the archives' Sigstore bundles. */
export function releaseFile(version: ReleaseVersion, name: string): string {
  return `${RELEASES}v${version.text}/${name}`;
}

// ---------------------------------------------------------------------------------------------
// Rollout
// ---------------------------------------------------------------------------------------------

export const AGENT_UPGRADE_STATES = ['running', 'succeeded', 'failed'] as const;
export type AgentUpgradeState = (typeof AGENT_UPGRADE_STATES)[number];

/** Why a rollout stopped, at the server whose turn it was. */
export const AGENT_UPGRADE_FAILURES = [
  // The server was not connected when its turn came, and did not come back in time.
  'node_unavailable',
  // Other actions kept running on the server: a deployment touches it.
  'node_busy',
  // The control plane could not read the release's digest or signature from GitHub.
  'release_unavailable',
  // The agent refused or failed the upgrade; the action's reason says why.
  'action_failed',
  // The agent came back with its previous version: the upgrade guard put it back.
  'rolled_back',
  // The agent never came back with the new version.
  'not_confirmed',
] as const;
export type AgentUpgradeFailure = (typeof AGENT_UPGRADE_FAILURES)[number];

export interface AgentUpgradeRecord {
  readonly id: string;
  readonly organizationId: string;
  /** The version every listed server goes to: the control plane's own. */
  readonly version: string;
  readonly state: AgentUpgradeState;
  /** The servers to upgrade, in order. */
  readonly nodeIds: readonly string[];
  /** Index in `nodeIds` of the server whose turn it is; `nodeIds.length` once all are done. */
  readonly position: number;
  /** The UpgradeAgent action sent to that server, once sent. */
  readonly actionId: string | null;
  /** When that server's turn began. */
  readonly turnStartedAt: Date;
  readonly failure: {
    readonly nodeId: string;
    readonly reason: AgentUpgradeFailure;
    readonly actionReason: ActionReason | null;
  } | null;
  readonly requestedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

/** The server whose turn it is, as the rollout reads it. */
export interface UpgradeNodeView {
  /** As observed now: a ready node whose heartbeats stopped reads as suspect or down. */
  readonly status: NodeStatus;
  readonly agentVersion: unknown;
  readonly architecture: unknown;
  readonly lastHeartbeatAt: Date | null;
  /** Another action of this server is not finished. */
  readonly busy: boolean;
}

/** The UpgradeAgent action of that server's turn. */
export interface UpgradeActionView {
  readonly state: AgentActionState;
  readonly reason: ActionReason | null;
  readonly completedAt: Date | null;
}

/** What the rollout does next. */
export type UpgradeStep =
  /** Every server had its turn. */
  | { readonly kind: 'finish' }
  /** This server needs nothing (gone, or already there): the next one's turn. */
  | { readonly kind: 'skip' }
  /** Send UpgradeAgent for this architecture. */
  | { readonly kind: 'send'; readonly architecture: AgentArchitecture }
  /** Look again after this many seconds, unless an event comes first. */
  | { readonly kind: 'wait'; readonly seconds: number }
  /** The server runs the new version: the next one's turn. */
  | { readonly kind: 'done' }
  | {
      readonly kind: 'fail';
      readonly reason: AgentUpgradeFailure;
      readonly actionReason: ActionReason | null;
    };

/** Timings of a turn (ADR 0028). */
export const UPGRADE_TIMINGS = {
  /** How often a waiting turn looks again; events wake it sooner. */
  pollSeconds: 15,
  /** A server that is not connected when its turn comes gets this long to come back. */
  unavailableMs: 5 * 60_000,
  /** A server busy with other actions gets this long before the rollout gives up. */
  busyMs: 30 * 60_000,
  /** Deadline of the UpgradeAgent action: a 10-minute download, then the swap. */
  actionMs: 30 * 60_000,
  /**
   * After its result, the previous binary stops within 2 minutes (the agent's restartWithin). A
   * heartbeat later than that, with the previous version, comes from the previous binary again:
   * the upgrade guard put it back.
   */
  previousStopsMs: 150_000,
  /**
   * How long the new version has to show up after the action succeeded: three starts, each of at
   * most 6 minutes (the unit's TimeoutStartSec), and margin.
   */
  confirmMs: 25 * 60_000,
} as const;

/** The servers a rollout to `target` lists: on an older release, on a released architecture. */
export function upgradeCandidates<
  T extends { readonly status: NodeStatus; readonly facts: Readonly<Record<string, unknown>> },
>(target: ReleaseVersion, nodes: readonly T[]): T[] {
  return nodes.filter((node) => {
    if (node.status === 'removed' || !isAgentArchitecture(node.facts['architecture'])) return false;
    const version = parseReleaseVersion(node.facts['agent_version']);
    return version !== null && compareVersions(version, target) < 0;
  });
}

/** What a running rollout does next, from the turn's server and its action. Pure. */
export function nextUpgradeStep(input: {
  readonly upgrade: AgentUpgradeRecord;
  /** Undefined when the server no longer exists. */
  readonly node: UpgradeNodeView | undefined;
  /** Undefined until the turn's action is sent. */
  readonly action: UpgradeActionView | undefined;
  readonly now: Date;
}): UpgradeStep {
  const { upgrade, node, action, now } = input;
  if (upgrade.position >= upgrade.nodeIds.length) return { kind: 'finish' };
  if (!node || node.status === 'removed') return { kind: 'skip' };
  const target = parseReleaseVersion(upgrade.version);
  const version = parseReleaseVersion(node.agentVersion);
  const arrived = target !== null && version !== null && compareVersions(version, target) >= 0;
  const waited = now.getTime() - upgrade.turnStartedAt.getTime();
  const wait: UpgradeStep = { kind: 'wait', seconds: UPGRADE_TIMINGS.pollSeconds };
  const fail = (reason: AgentUpgradeFailure, actionReason: ActionReason | null = null) =>
    ({ kind: 'fail', reason, actionReason }) as const;

  if (!action) {
    // Before the action: a server already there, or that cannot take a release, is skipped.
    if (arrived || version === null || !isAgentArchitecture(node.architecture))
      return { kind: 'skip' };
    if (node.status !== 'ready')
      return waited >= UPGRADE_TIMINGS.unavailableMs ? fail('node_unavailable') : wait;
    // Never while another action runs there: a deployment touches the server.
    if (node.busy) return waited >= UPGRADE_TIMINGS.busyMs ? fail('node_busy') : wait;
    return { kind: 'send', architecture: node.architecture };
  }
  switch (action.state) {
    case 'succeeded':
      break;
    case 'failed':
    case 'compensated':
    case 'cancelled':
    case 'expired':
      return fail('action_failed', action.reason);
    default:
      // The agent expires an overdue action only while it is connected: a server that never
      // comes back ends the turn here.
      return waited >= UPGRADE_TIMINGS.actionMs + UPGRADE_TIMINGS.unavailableMs
        ? fail('not_confirmed')
        : wait;
  }
  if (arrived) return { kind: 'done' };
  const succeededAt = (action.completedAt ?? upgrade.turnStartedAt).getTime();
  // A heartbeat from a process started after the previous binary stopped, still on the previous
  // version: the guard put the previous binary back.
  if (
    node.lastHeartbeatAt &&
    node.lastHeartbeatAt.getTime() >= succeededAt + UPGRADE_TIMINGS.previousStopsMs
  )
    return fail('rolled_back');
  return now.getTime() - succeededAt >= UPGRADE_TIMINGS.confirmMs ? fail('not_confirmed') : wait;
}

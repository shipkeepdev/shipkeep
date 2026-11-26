import type { ObservedState, ReportedContainer } from './observations';

/**
 * Untracked containers (#501). A restore brings the control plane back to its backup, while the
 * servers keep running what was deployed since: those containers match no replica the restored
 * database placed, and nothing removes them. Agents report every managed container; the ones that
 * match no placed replica are kept per node, and those whose name says they belong to an
 * application of the organization are listed as untracked, for an administrator to remove.
 */

/** A managed container the node reported that matches no replica placed on it. */
export interface UnmatchedContainer {
  readonly name: string;
  readonly containerId: string;
  readonly state: Exclude<ObservedState, 'missing'>;
  /** When the node's reports started holding this set. */
  readonly observedAt: Date;
}

/** Who a container name says it belongs to: `sk-<name>-<last 12 of the application id>-r<release>-<replica|task>`. */
export interface ContainerOwner {
  readonly applicationSuffix: string;
  readonly release: number;
  readonly replica: number | 'task';
}

const OWNED = /^sk-[a-z0-9-]{0,24}-([0-9a-f]{12})-r([1-9][0-9]{0,8})-(0|[1-9][0-9]{0,3}|task)$/;

/** The owner a container name states, as `containerName` builds it; undefined for any other name. */
export function containerOwner(name: string): ContainerOwner | undefined {
  const match = OWNED.exec(name);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    applicationSuffix: match[1],
    release: Number(match[2]),
    replica: match[3] === 'task' ? 'task' : Number(match[3]),
  };
}

/** Whether the reported set differs from the stored one: a name, a container or a state changed. */
export function unmatchedChanged(
  stored: readonly UnmatchedContainer[],
  reported: readonly ReportedContainer[],
): boolean {
  if (stored.length !== reported.length) return true;
  const known = new Map(stored.map((container) => [container.name, container]));
  return reported.some((container) => {
    const before = known.get(container.name);
    return (
      !before || before.containerId !== container.containerId || before.state !== container.state
    );
  });
}

/** An application of the organization, with whether a deployment of it is underway. */
export interface OwningApplication {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploying: boolean;
}

export interface UntrackedContainer extends UnmatchedContainer {
  readonly application: Omit<OwningApplication, 'deploying'>;
  readonly release: number;
  readonly replica: number | 'task';
}

/**
 * The unmatched containers that are untracked: named after exactly one application of the
 * organization, none of whose deployments is underway. A deployment underway may still create,
 * run (a release task) or drain containers of its application, which match no placed replica for a
 * while and are not left behind.
 */
export function untrackedContainers(
  unmatched: readonly UnmatchedContainer[],
  applications: readonly OwningApplication[],
): UntrackedContainer[] {
  const untracked: UntrackedContainer[] = [];
  for (const container of unmatched) {
    const owner = containerOwner(container.name);
    if (!owner) continue;
    const owners = applications.filter((application) =>
      application.id.endsWith(owner.applicationSuffix),
    );
    const application = owners.length === 1 ? owners[0] : undefined;
    if (!application || application.deploying) continue;
    untracked.push({
      ...container,
      application: {
        id: application.id,
        name: application.name,
        projectId: application.projectId,
        environmentId: application.environmentId,
      },
      release: owner.release,
      replica: owner.replica,
    });
  }
  return untracked.sort((a, b) => a.name.localeCompare(b.name));
}

/** The suffixes the unmatched containers name, to look their applications up. */
export function ownerSuffixes(unmatched: readonly UnmatchedContainer[]): string[] {
  const suffixes = new Set<string>();
  for (const container of unmatched) {
    const owner = containerOwner(container.name);
    if (owner) suffixes.add(owner.applicationSuffix);
  }
  return [...suffixes].sort();
}

/** The confirmation target of an untracked container's removal: its node and its name. */
export function untrackedTarget(nodeId: string, name: string): string {
  return `${nodeId}/${name}`;
}

/** The node and name of a confirmation target, when it is one. */
export function parseUntrackedTarget(
  target: string,
): { readonly nodeId: string; readonly name: string } | undefined {
  const match = /^([0-9a-f-]{36})\/(sk-[a-z0-9-]{1,60})$/.exec(target);
  return match?.[1] && match[2] ? { nodeId: match[1], name: match[2] } : undefined;
}

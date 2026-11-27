/**
 * Which images of an application the installation's registry keeps (ADR 0030): those a rollback
 * can reach, and those a deployment still needs. Pure: the caller reads releases and deployments,
 * and removes the rest from the registry.
 */

/** The release that serves and the five successful ones before it (ADR 0012, ADR 0030). */
export const KEPT_SUCCESSFUL_RELEASES = 6;

/** A release as retention reads it: its number, which is its tag, and its deployments. */
export interface RetainedRelease {
  readonly number: number;
  readonly deployments: readonly {
    readonly state: string;
    /** When the deployment ended; null while it runs. */
    readonly finishedAt: Date | null;
  }[];
}

/**
 * The tags to keep: every release a deployment still runs for, and the six releases most
 * recently deployed with success. Recency is that of their last successful deployment, not their
 * number: after a rollback to an old release, that release is the one that serves. A release
 * whose deployments all failed or were cancelled is kept by nothing.
 */
export function keptTags(releases: readonly RetainedRelease[]): Set<string> {
  const kept = new Set<string>();
  const succeeded: { number: number; at: number }[] = [];
  for (const release of releases) {
    if (release.deployments.some((deployment) => deployment.finishedAt === null))
      kept.add(String(release.number));
    const last = Math.max(
      ...release.deployments
        .filter((deployment) => deployment.state === 'succeeded' && deployment.finishedAt)
        .map((deployment) => deployment.finishedAt?.getTime() ?? 0),
    );
    if (Number.isFinite(last)) succeeded.push({ number: release.number, at: last });
  }
  succeeded
    .sort((a, b) => b.at - a.at || b.number - a.number)
    .slice(0, KEPT_SUCCESSFUL_RELEASES)
    .forEach((release) => kept.add(String(release.number)));
  return kept;
}

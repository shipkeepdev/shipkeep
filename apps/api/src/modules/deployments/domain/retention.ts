/**
 * Which images of an application the installation's registry keeps (ADR 0030): those a rollback
 * can reach, and those a deployment still needs. Pure: the caller reads releases and deployments,
 * and removes the other tags from the registry.
 */
import { parseImageReference } from './image-reference';

/** The release that serves and the five successful ones before it (ADR 0012, ADR 0030). */
export const KEPT_SUCCESSFUL_RELEASES = 6;

/** A release as retention reads it: its number, its image and its deployments. */
export interface RetainedRelease {
  readonly number: number;
  /**
   * What it runs. A built release's own tag, `<registry>/<repository>:<number>`; a rollback's copy
   * runs its source's image, so its tag is the source's.
   */
  readonly image: string;
  readonly deployments: readonly {
    readonly state: string;
    /** When the deployment ended; null while it runs. */
    readonly finishedAt: Date | null;
  }[];
}

/**
 * The tags of `repository` to keep: those of every release a deployment still runs for, and of
 * the six releases most recently deployed with success. Recency is that of their last successful
 * deployment, not their number: after a rollback to an old release, that release is the one that
 * serves. A release whose deployments all failed or were cancelled is kept by nothing.
 */
export function keptTags(releases: readonly RetainedRelease[], repository: string): Set<string> {
  const kept: RetainedRelease[] = [];
  const succeeded: { release: RetainedRelease; at: number }[] = [];
  for (const release of releases) {
    if (release.deployments.some((deployment) => deployment.finishedAt === null))
      kept.push(release);
    const last = Math.max(
      ...release.deployments
        .filter((deployment) => deployment.state === 'succeeded' && deployment.finishedAt)
        .map((deployment) => deployment.finishedAt?.getTime() ?? 0),
    );
    if (Number.isFinite(last)) succeeded.push({ release, at: last });
  }
  succeeded
    .sort((a, b) => b.at - a.at || b.release.number - a.release.number)
    .slice(0, KEPT_SUCCESSFUL_RELEASES)
    .forEach(({ release }) => kept.push(release));
  const tags = new Set<string>();
  for (const release of kept) {
    const tag = tagIn(release.image, repository);
    if (tag !== undefined) tags.add(tag);
  }
  return tags;
}

/** The tag `image` names in `repository`, if it names one there. */
function tagIn(image: string, repository: string): string | undefined {
  try {
    const reference = parseImageReference(image);
    return reference.repository === repository ? (reference.tag ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

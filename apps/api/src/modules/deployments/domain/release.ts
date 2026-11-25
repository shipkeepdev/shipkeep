import type { ShipkeepConfig } from '@shipkeep/config-schema';
import {
  ConflictError,
  type Deployment,
  type DeploymentPlan,
  type DeploymentState,
  InvalidInputError,
} from '@shipkeep/domain';

/** An immutable snapshot of an application's configuration and image (SPEC 1, 4). */
export interface Release {
  readonly id: string;
  readonly organizationId: string;
  readonly applicationId: string;
  /** 1, 2, 3... per application, in creation order. */
  readonly number: number;
  readonly image: string;
  /** Recorded once when the pipeline resolves the image (M3.4c); null until then. */
  readonly imageDigest: string | null;
  readonly config: ShipkeepConfig;
  readonly configSha: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export const DEPLOYMENT_TRIGGERS = ['manual', 'webhook', 'rollback'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/** A deployment row: the SPEC 5.1 aggregate plus what it deploys and who asked. */
export interface DeploymentRecord extends Deployment {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly releaseId: string;
  readonly trigger: DeploymentTrigger;
  readonly actorId: string | null;
}

/** What a new release needs from the application's current configuration. */
export interface ReleaseDraft {
  readonly image: string;
  readonly plan: DeploymentPlan;
  /** Secret names the release injects; all must be set before it is queued (SPEC 2.2). */
  readonly secrets: readonly string[];
}

/** Image applications only (M3.4b1): the image is pulled, never built. */
export function releaseDraft(config: ShipkeepConfig): ReleaseDraft {
  const image = config.build?.type === 'image' ? config.build.image : undefined;
  if (!image)
    throw new InvalidInputError(
      'unsupported_application_source',
      'Only image applications can be deployed for now.',
    );
  return {
    image,
    plan: { build: false, release: config.release !== undefined },
    secrets: [...new Set(config.secrets ?? [])].sort(),
  };
}

/** Rejects a deployment whose referenced secrets are not all set; names are not secret. */
export function assertSecretsSet(required: readonly string[], set: readonly string[]): void {
  const available = new Set(set);
  const missing = required.filter((name) => !available.has(name));
  if (missing.length)
    throw new ConflictError(
      'secrets_missing',
      'Set the secrets the configuration references before deploying.',
      { missing },
    );
}

/**
 * A stop is a deployment of the release that runs, with a plan that starts nothing: the pipeline
 * only removes the routes and the replicas (SPEC 5.1). It needs no secret and no image.
 */
export function stopDraft(running: Release): ReleaseDraft {
  return { image: running.image, plan: { build: false, release: false, stop: true }, secrets: [] };
}

export function applicationNotRunning(): ConflictError {
  return new ConflictError(
    'application_not_running',
    'The application has no running replica to stop.',
  );
}

export function applicationRunning(): ConflictError {
  return new ConflictError(
    'application_running',
    'Stop the application before deleting it: it still has running replicas.',
  );
}

/**
 * A server has not confirmed yet that the application's containers and routes are gone (#474):
 * deleting it now could free a domain a route still serves.
 */
export function applicationCleanupPending(): ConflictError {
  return new ConflictError(
    'application_cleanup_pending',
    "A server has not confirmed yet that this application's containers and routes are gone; it has been asked to remove them. Retry in a moment, or remove that server.",
  );
}

export function deploymentInProgress(state?: DeploymentState): ConflictError {
  return new ConflictError(
    'deployment_in_progress',
    'Another deployment of this application is still running.',
    state ? { state } : undefined,
  );
}

/**
 * A rollback deploys a new release copying an earlier one's pinned image and configuration, so the
 * pipeline, allocations and history work as for any release. The release command does not run
 * again: migrations of an older version must not be replayed over newer data.
 */
export function rollbackDraft(source: Release): ReleaseDraft {
  if (!source.imageDigest)
    throw new ConflictError(
      'release_not_deployable',
      'This release never resolved its image, so it cannot be rolled back to.',
    );
  return {
    image: source.image,
    plan: { build: false, release: false },
    secrets: [...new Set(source.config.secrets ?? [])].sort(),
  };
}

/** Only a version that actually ran, and is not the one serving now, can be rolled back to. */
export function assertRollbackTarget(
  target: DeploymentRecord,
  serving: DeploymentRecord | undefined,
): void {
  if (target.state !== 'succeeded' && target.state !== 'rolled_back')
    throw new ConflictError(
      'rollback_target_invalid',
      'Only a deployment that succeeded can be rolled back to.',
      { state: target.state },
    );
  if (serving?.releaseId === target.releaseId)
    throw new ConflictError('release_already_serving', 'This release is already serving.');
}

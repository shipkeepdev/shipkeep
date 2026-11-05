import type { DeploymentState } from '@shipkeep/domain';

import type { Application } from '../../apps/domain/application';
import type { DeploymentRecord, DeploymentTrigger, Release, ReleaseDraft } from '../domain/release';

export const DEPLOYMENT_STORE = Symbol('DeploymentStore');
/** Every method runs inside `runTenant` for the application's organization. */
export interface DeploymentStore {
  active(applicationId: string): Promise<DeploymentRecord | undefined>;
  /** Snapshots the configuration as the next release number; undefined on a concurrent insert. */
  createRelease(
    application: Application,
    draft: ReleaseDraft,
    actorId: string,
    now: Date,
  ): Promise<Release | undefined>;
  /** Inserts a queued deployment; undefined when another one is active (SPEC 4 invariant). */
  queue(
    release: Release,
    draft: ReleaseDraft,
    trigger: DeploymentTrigger,
    actorId: string,
    now: Date,
  ): Promise<DeploymentRecord | undefined>;
  find(applicationId: string, deploymentId: string): Promise<DeploymentRecord | undefined>;
  list(applicationId: string): Promise<DeploymentRecord[]>;
  releases(applicationId: string): Promise<Release[]>;
  /** Stores a finished deployment if it is still in `expected`; false when it moved meanwhile. */
  finish(deployment: DeploymentRecord, expected: DeploymentState, now: Date): Promise<boolean>;
}

export const IMAGE_RESOLVER = Symbol('ImageResolver');
/** Turns an image reference into the digest-pinned form agents accept (ADR 0012). */
export interface ImageResolver {
  /** Returns `<name>@sha256:…`; throws `image_resolution_failed` or `invalid_image_reference`. */
  resolve(reference: string): Promise<string>;
}

export const DEPLOYMENT_TRANSACTION = Symbol('DeploymentTransaction');
export interface DeploymentTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

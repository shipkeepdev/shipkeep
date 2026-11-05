import type { DeploymentState } from '@shipkeep/domain';

import type { Application } from '../../apps/domain/application';
import type { Allocation, StepOutcome } from '../domain/pipeline';
import type { NodeLoad, NodeView } from '../domain/placement';
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
  /** Stores the deployment's new state if it is still in `expected`; false when it moved meanwhile. */
  transition(deployment: DeploymentRecord, expected: DeploymentState, now: Date): Promise<boolean>;
}

/** A placed replica as stored (SPEC 4 `Allocation`). */
export interface StoredAllocation extends Allocation {
  readonly id: string;
  readonly releaseId: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

export const PIPELINE_STORE = Symbol('PipelineStore');
/** What the pipeline worker reads and writes; every method runs inside `runTenant`. */
export interface PipelineStore {
  /** Placed (not stopped) replicas of the application, across releases. */
  allocations(applicationId: string): Promise<StoredAllocation[]>;
  /** Stores the placement of a release; false when it was already placed (concurrent worker). */
  place(
    organizationId: string,
    applicationId: string,
    releaseId: string,
    replicas: readonly Omit<StoredAllocation, 'id' | 'releaseId'>[],
    now: Date,
  ): Promise<boolean>;
  /** Marks the application's replicas of these releases stopped. */
  stop(applicationId: string, releaseIds: readonly string[], now: Date): Promise<void>;
  /** Records the resolved digest once; false when one was already recorded. */
  recordDigest(releaseId: string, digest: string): Promise<boolean>;
  release(releaseId: string): Promise<Release | undefined>;
  /** Outcomes of the deployment's agent actions, by idempotency key. */
  steps(deploymentId: string): Promise<Map<string, StepOutcome>>;
  nodes(organizationId: string): Promise<NodeView[]>;
  /** Placed replicas summed per node id. */
  load(organizationId: string): Promise<Map<string, NodeLoad>>;
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

import type { Secret } from '@shipkeep/domain';

import type { CreatedGithubApp, GithubAppMetadata } from '../domain/github-app';
import type { DeliveryHeaders, InstallationChange } from '../domain/github-webhook';

/** A manifest flow under way: the hashed state GitHub brings back, and who started it. */
export interface GithubAppFlow {
  readonly stateHash: Uint8Array;
  readonly userId: string;
  readonly expiresAt: Date;
}

export const GITHUB_APP_STORE = Symbol('GithubAppStore');
/** Every method runs inside `runTenant` for the organization. */
export interface GithubAppStore {
  organizationSlug(organizationId: string): Promise<string>;
  find(organizationId: string): Promise<GithubAppMetadata | undefined>;
  /** Starts a flow, replacing one under way. */
  startFlow(organizationId: string, flow: GithubAppFlow): Promise<void>;
  flow(organizationId: string): Promise<GithubAppFlow | undefined>;
  /**
   * Stores the App and ends its flow, if that flow is still the one whose state hashes to
   * `stateHash`; false otherwise. The store encrypts the App's secrets.
   */
  create(
    organizationId: string,
    stateHash: Uint8Array,
    app: CreatedGithubApp,
    createdBy: string,
    now: Date,
  ): Promise<GithubAppMetadata | undefined>;
}

export const GITHUB_WEBHOOK_STORE = Symbol('GithubWebhookStore');
/** Every method runs inside `runTenant` for the organization. */
export interface GithubWebhookStore {
  /** The App's identifier and decrypted webhook secret, or undefined without an App. */
  webhookSecret(organizationId: string): Promise<{ appId: number; secret: Secret } | undefined>;
  /**
   * Records a delivery; false when it was recorded before. Deliveries older than the retention
   * are forgotten on the way.
   */
  recordDelivery(organizationId: string, delivery: DeliveryHeaders, now: Date): Promise<boolean>;
  /** Applies an installation change; false when it changed nothing. */
  applyInstallation(
    organizationId: string,
    change: InstallationChange,
    now: Date,
  ): Promise<boolean>;
}

export const GITHUB_MANIFESTS = Symbol('GithubManifests');
/** GitHub's manifest conversion: the temporary code for the App it created, with its secrets. */
export interface GithubManifests {
  convert(code: string): Promise<unknown>;
}

export const GIT_TRANSACTION = Symbol('GitTransaction');
export interface GitTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

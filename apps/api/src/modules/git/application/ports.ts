import type { Secret } from '@shipkeep/domain';

import type { GithubRepository, TokenScope } from '../domain/github-api';
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
  /** The App's identifier and decrypted private key, or undefined without an App. */
  credentials(organizationId: string): Promise<{ appId: number; privateKey: Secret } | undefined>;
  /** The installations GitHub reported and did not suspend, oldest first. */
  activeInstallations(organizationId: string): Promise<number[]>;
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
   * Records a delivery; false when its identifier or its body was recorded before. Deliveries
   * older than the retention are forgotten on the way.
   */
  recordDelivery(
    organizationId: string,
    delivery: DeliveryHeaders,
    bodySha256: Uint8Array,
    now: Date,
  ): Promise<boolean>;
  /**
   * Applies an installation change under a lock per installation, inside the delivery's
   * transaction, recording an installation it did not know; a removal leaves a tombstone, even of
   * one never recorded. False when `changeApplies` refuses the change: older, the same time and
   * not more restrictive, or aimed at a tombstone.
   */
  applyInstallation(
    organizationId: string,
    change: InstallationChange,
    now: Date,
  ): Promise<boolean>;
}

export const GITHUB_API = Symbol('GithubApi');
/** GitHub's REST API, as the organization's App (ADR 0031). */
export interface GithubApi {
  appJwt(appId: number, privateKey: Secret, now: Date): Secret;
  /**
   * A token for an installation, scoped to what a call needs. Undefined when GitHub refuses the
   * repositories asked for: they are not, or no longer, in the installation.
   */
  installationToken(
    jwt: Secret,
    installationId: number,
    scope: TokenScope,
  ): Promise<{ token: Secret; expiresAt: Date } | undefined>;
  repositories(
    token: Secret,
    installationId: number,
    limit: number,
  ): Promise<{ repositories: GithubRepository[]; truncated: boolean }>;
  /** The commit a branch points to; undefined when the repository or branch is unknown. */
  branchHead(token: Secret, fullName: string, branch: string): Promise<string | undefined>;
  /** A repository by GitHub's identifier; undefined when the token does not reach it. */
  repository(
    token: Secret,
    installationId: number,
    repositoryId: number,
  ): Promise<GithubRepository | undefined>;
  /**
   * A file's text at a commit, at most the largest shipkeep.yml; undefined when the path does not
   * name a file there. A larger file, or any other failure, is GitHub unavailable.
   */
  file(token: Secret, fullName: string, path: string, commit: string): Promise<string | undefined>;
  revoke(token: Secret): Promise<void>;
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

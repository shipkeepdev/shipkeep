import type { Secret } from '@shipkeep/domain';
import type {
  Application,
  ApplicationConfig,
  ApplicationHost,
  ApplicationRepository,
  ApplicationTarget,
} from '../domain/application';
import type {
  CertificateChange,
  CertificateDomain,
  DomainCertificate,
  StoredCertificate,
} from '../domain/certificates';

/** A repository's shipkeep.yml at a commit, as GitHub returned it (ADR 0031). */
export interface RepositoryConfig {
  /** The repository's current `owner/name`: GitHub's identifier stays, its name may change. */
  readonly fullName: string;
  readonly commitSha: string;
  /** The file's text, at most the largest shipkeep.yml. */
  readonly text: string;
}

/** The file a change from the interface replaces (#214), with the blob a write must name. */
export interface RepositoryConfigFile extends RepositoryConfig {
  readonly blobSha: string;
}

/** How a change of the file goes into the repository: the project's `gitWriteMode`. */
export type GitWriteMode = 'commit' | 'pull_request';

/** A change of the file, written against the blob it was made from (#214). */
export interface RepositoryConfigChange {
  /**
   * The change's own name: a digest of where it goes, the blob it was made against and the
   * document asked for. Its commits carry it, and its pull request's branch is named after it, so
   * an attempt that repeats an earlier one finds what that one wrote (#214).
   */
  readonly changeId: string;
  readonly blobSha: string;
  readonly text: string;
  /** The commit's first line, and the pull request's title. */
  readonly title: string;
  /** The rest of the commit message, and the pull request's text. */
  readonly body: string;
  readonly mode: GitWriteMode;
}

/** Where a change went: a commit on the branch, or a pull request into it. */
export type WrittenConfigChange =
  | { readonly via: 'commit'; readonly commitSha: string; readonly url: string }
  | {
      readonly via: 'pull_request';
      readonly commitSha: string;
      readonly url: string;
      readonly number: number;
      readonly branch: string;
    };

/** Where a Git application's configuration is read, without its name, which GitHub gives. */
export type RepositoryLocation = Omit<ApplicationRepository, 'fullName' | 'commitSha'>;

export const REPOSITORY_SOURCE = Symbol('RepositorySource');
/**
 * Reads a Git application's configuration from its repository, through the organization's
 * GitHub App (the `git` module). It checks no permission: callers do. It runs no transaction of
 * its own around GitHub's answers, so callers call it outside theirs.
 */
export interface RepositorySource {
  /** At `commit`, or at the branch's head when no commit is given. */
  read(
    organizationId: string,
    location: RepositoryLocation,
    commit?: string,
  ): Promise<RepositoryConfig>;
  /**
   * The file at the branch's head, with its blob (#214): what a change from the interface is made
   * against. Read with a token that reads that repository's contents only.
   */
  readForChange(
    organizationId: string,
    location: RepositoryLocation,
  ): Promise<RepositoryConfigFile>;
  /**
   * Writes a change of the file (#214, ADR 0031): a commit on the branch in `commit` mode, or a
   * pull request from a branch of its own. A commit that GitHub refuses on an unchanged file, as a
   * protected branch does, becomes a pull request. A file whose blob is no longer `change.blobSha`
   * answers `config_file_changed`, and nothing is written. Uses a token that writes that one
   * repository's contents and pull requests, revoked once used.
   */
  writeConfig(
    organizationId: string,
    location: RepositoryLocation,
    change: RepositoryConfigChange,
  ): Promise<WrittenConfigChange>;
  /**
   * The commit at the branch's head when its message carries `changeId`: an earlier attempt of the
   * same change committed it, and the branch moved on by that commit. Read with a token that reads
   * that repository's contents only.
   */
  writtenChange(
    organizationId: string,
    location: RepositoryLocation,
    changeId: string,
  ): Promise<WrittenConfigChange | undefined>;
  /**
   * What a build fetches the repository with (ADR 0030): its HTTPS URL, under its current name,
   * and a token that reads that repository's contents and nothing else, until it expires. The
   * build carries the token; `revoke` ends it once the build has.
   */
  buildAccess(
    organizationId: string,
    location: Pick<RepositoryLocation, 'installationId' | 'repositoryId'>,
  ): Promise<{ url: string; token: Secret; expiresAt: Date }>;
  /**
   * Revokes a token `buildAccess` minted: true once GitHub no longer honours it, false when GitHub
   * could not be asked. A token not revoked still expires within the hour.
   */
  revoke(token: Secret): Promise<boolean>;
}

/** A Git application a push may deploy, and whether a push may deploy it by itself (SPEC 7). */
/** A page of a push's applications holds at most this many: a job handles one page. */
export const MAX_FOLLOWERS = 20;

/** Which of a push's applications a page holds: those after `after`, or only those named. */
export interface FollowerPage {
  readonly after?: string;
  readonly only?: readonly string[];
}

/** Where a repository's branch head is, as GitHub answered for it. */
export type RepositoryHead = Pick<RepositoryConfig, 'fullName' | 'commitSha'>;

export interface RepositoryFollower {
  readonly application: Application;
  /** In a protected environment, a push changes the configuration and deploys nothing. */
  readonly protectedEnvironment: boolean;
}

export const APPLICATION_STORE = Symbol('ApplicationStore');
/** Every method runs inside `runTenant` for the target's organization. */
export interface ApplicationStore {
  /**
   * Returns undefined when the name is already taken in the environment. A Git application comes
   * with its repository.
   */
  create(
    target: ApplicationTarget,
    config: ApplicationConfig,
    configSha: string,
    actorId: string,
    now: Date,
    repository?: ApplicationRepository | null,
  ): Promise<Application | undefined>;
  /**
   * Replaces the configuration if it still has `expectedSha`; undefined when it changed. A Git
   * application's `head` is the repository's name and the commit the configuration was read at.
   */
  replaceConfig(
    application: Application,
    expectedSha: string,
    config: ApplicationConfig,
    configSha: string,
    now: Date,
    head?: RepositoryHead,
  ): Promise<Application | undefined>;
  find(target: ApplicationTarget, applicationId: string): Promise<Application | undefined>;
  /** How the target's project writes a change of a repository's file (#214). */
  writeMode(target: ApplicationTarget): Promise<GitWriteMode>;
  /**
   * A page of the Git applications of the organization that follow this branch of this
   * repository through this installation: at most `MAX_FOLLOWERS`, in identifier order, after
   * `page.after` or among `page.only`. A push reaches them all by asking for the page after the
   * last one until a page is not full.
   */
  followers(
    organizationId: string,
    push: { installationId: number; repositoryId: number; branch: string },
    page?: FollowerPage,
  ): Promise<Application[]>;
  /** A Git application by id, with whether its environment is protected now. */
  follower(organizationId: string, applicationId: string): Promise<RepositoryFollower | undefined>;
  /** The application by id within its organization, wherever it lives (confirmation targets). */
  findById(organizationId: string, applicationId: string): Promise<Application | undefined>;
  /**
   * Locks the application's row until the transaction ends; false when it no longer exists. A
   * deployment queued at the same moment references that row, so it either commits before the
   * lock is granted, and is then seen, or fails once the application is gone.
   */
  lock(application: Pick<Application, 'id' | 'organizationId'>): Promise<boolean>;
  /**
   * Deletes the application and, by cascade, its releases, deployments, stopped allocations and
   * claimed domains. False when it no longer exists. The caller locks it and makes sure nothing
   * runs.
   */
  delete(application: Pick<Application, 'id' | 'organizationId'>): Promise<boolean>;
  /**
   * Makes `hostnames` the application's claimed domains; a dropped domain that a placed release
   * still lists stays reserved until releaseUnservedDomains frees it. `taken` is a hostname
   * another application of the organization already claims, in which case the caller must abort
   * the transaction. `released` lists the reservations freed on the way, which the caller audits.
   */
  syncDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
    hostnames: readonly string[],
    now: Date,
  ): Promise<DomainSync>;
  /**
   * Frees the domains the configuration dropped that no placed release of the application lists
   * any more (#302). Until then they stay reserved, so no other application can claim a domain
   * that a running route may still serve. Returns the hostnames freed, sorted, which the caller
   * audits (`domainsReleased`).
   */
  releaseUnservedDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
  ): Promise<string[]>;
  list(target: ApplicationTarget): Promise<Application[]>;
  /**
   * The organization's nodes, not removed, with a placed replica of the application that their
   * agent last saw running. Node addresses never leave the domain check.
   */
  hosts(application: Pick<Application, 'id' | 'organizationId'>): Promise<ApplicationHost[]>;
}

/** The control plane's own host name, from `API_PUBLIC_URL`, which no application may claim. */
export const CONTROL_PLANE_HOST = Symbol('CONTROL_PLANE_HOST');

export const DOMAIN_RESOLVER = Symbol('DomainResolver');
/** Looks up a hostname's addresses; undefined when the lookup itself failed. */
export interface DomainResolver {
  addresses(hostname: string): Promise<readonly string[] | undefined>;
}

export const APPLICATION_TRANSACTION = Symbol('ApplicationTransaction');
export interface ApplicationTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

/** The outcome of syncDomains. */
export interface DomainSync {
  readonly taken: string | undefined;
  readonly released: readonly string[];
}

export const DOMAIN_CERTIFICATE_STORE = Symbol('DomainCertificateStore');
/** Readings of the certificates nodes serve for domains. Every method runs inside `runTenant`. */
export interface DomainCertificateStore {
  /** The organization's domains among these host names, with the node's readings for them. */
  onNode(
    organizationId: string,
    nodeId: string,
    hostnames: readonly string[],
  ): Promise<{ domains: CertificateDomain[]; stored: StoredCertificate[] }>;
  apply(
    organizationId: string,
    nodeId: string,
    changes: readonly CertificateChange[],
    now: Date,
  ): Promise<void>;
  /**
   * For each domain of the application, by host name, the reading observed after freshSince
   * that expires first, among every node's.
   */
  forApplication(
    organizationId: string,
    applicationId: string,
    freshSince: Date,
  ): Promise<Map<string, DomainCertificate>>;
}

import type {
  Application,
  ApplicationConfig,
  ApplicationHost,
  ApplicationTarget,
} from '../domain/application';

export const APPLICATION_STORE = Symbol('ApplicationStore');
/** Every method runs inside `runTenant` for the target's organization. */
export interface ApplicationStore {
  /** Returns undefined when the name is already taken in the environment. */
  create(
    target: ApplicationTarget,
    config: ApplicationConfig,
    configSha: string,
    actorId: string,
    now: Date,
  ): Promise<Application | undefined>;
  /** Replaces the configuration if it still has `expectedSha`; undefined when it changed. */
  replaceConfig(
    application: Application,
    expectedSha: string,
    config: ApplicationConfig,
    configSha: string,
    now: Date,
  ): Promise<Application | undefined>;
  find(target: ApplicationTarget, applicationId: string): Promise<Application | undefined>;
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

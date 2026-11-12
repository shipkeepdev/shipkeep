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
  /**
   * Makes `hostnames` the application's claimed domains. Returns a hostname another application of
   * the organization already claims, in which case the caller must abort the transaction.
   */
  syncDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
    hostnames: readonly string[],
    now: Date,
  ): Promise<string | undefined>;
  list(target: ApplicationTarget): Promise<Application[]>;
  /**
   * The organization's nodes, not removed, with a placed replica of the application that their
   * agent last saw running. Node addresses never leave the domain check.
   */
  hosts(application: Pick<Application, 'id' | 'organizationId'>): Promise<ApplicationHost[]>;
}

export const DOMAIN_RESOLVER = Symbol('DomainResolver');
/** Looks up a hostname's addresses; undefined when the lookup itself failed. */
export interface DomainResolver {
  addresses(hostname: string): Promise<readonly string[] | undefined>;
}

export const APPLICATION_TRANSACTION = Symbol('ApplicationTransaction');
export interface ApplicationTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

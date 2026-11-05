import type { Application, ApplicationConfig, ApplicationTarget } from '../domain/application';

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
  list(target: ApplicationTarget): Promise<Application[]>;
}

export const APPLICATION_TRANSACTION = Symbol('ApplicationTransaction');
export interface ApplicationTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

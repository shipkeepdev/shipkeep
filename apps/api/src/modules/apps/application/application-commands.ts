import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { parseShipkeepConfig } from '@shipkeep/config-schema';
import {
  type Actor,
  ConflictError,
  createEvent,
  InvalidInputError,
  NotFoundError,
  type Permission,
  SYSTEM_ACTOR,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { isPublicAddress } from '../../../platform/net/public-address';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  type Application,
  applicationConfig,
  type ApplicationTarget,
  assertConfigEditable,
  assertDomainsAvailable,
  assertSameName,
  type DomainDns,
  domainDns,
} from '../domain/application';
import { CERTIFICATE_STALE_MS, type DomainCertificate } from '../domain/certificates';
import { domainsReleased } from '../domain/domain-events';

import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  type ApplicationStore,
  type ApplicationTransaction,
  CONTROL_PLANE_HOST,
  DOMAIN_CERTIFICATE_STORE,
  DOMAIN_RESOLVER,
  type DomainCertificateStore,
  type DomainResolver,
  type RepositoryFollower,
  REPOSITORY_SOURCE,
  type RepositoryLocation,
  type RepositorySource,
} from './ports';

/** What the domain list shows: where the name points, and the certificate nodes serve for it. */
export interface DomainStatus extends DomainDns {
  /** The recent reading that expires first, undefined while no node reported one. */
  readonly certificate: DomainCertificate | undefined;
}

/**
 * Applications of an environment (SPEC 4, PLAN M3.4b). Defining or changing one needs `deploy.run`
 * (developers only on unprotected environments, SPEC 7), because a configuration change takes
 * effect at the next deployment; reading needs `environment.read`.
 */
@Injectable()
export class ApplicationCommands {
  constructor(
    @Inject(APPLICATION_STORE) private readonly store: ApplicationStore,
    @Inject(APPLICATION_TRANSACTION) private readonly transaction: ApplicationTransaction,
    @Inject(DOMAIN_RESOLVER) private readonly resolver: DomainResolver,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
    @Inject(CONTROL_PLANE_HOST) private readonly controlPlaneHost: string,
    @Inject(DOMAIN_CERTIFICATE_STORE) private readonly certificates: DomainCertificateStore,
    @Inject(REPOSITORY_SOURCE) private readonly repositories: RepositorySource,
  ) {}

  /**
   * Creates an application whose configuration is the shipkeep.yml of a GitHub repository, read
   * at the branch's head (ADR 0031). GitHub is asked between two checks of the caller's access,
   * outside any transaction. Deploying stays a separate request.
   */
  async createFromRepository(
    context: SecurityContext,
    target: ApplicationTarget,
    location: RepositoryLocation,
    now = new Date(),
  ): Promise<Application> {
    await this.scoped(context, 'deploy.run', target, () => Promise.resolve());
    const read = await this.repositories.read(target.organizationId, location);
    const parsed = parseShipkeepConfig(read.text);
    if (!parsed.ok)
      throw new InvalidInputError(
        'invalid_application_config',
        `The configuration at ${location.configPath} is invalid.`,
        { issues: parsed.issues.slice(0, 20), commit: read.commitSha },
      );
    const config = applicationConfig(parsed.config, 'git');
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    const repository = { ...location, fullName: read.fullName, commitSha: read.commitSha };
    return this.scoped(context, 'deploy.run', target, async () => {
      const created = await this.store.create(
        target,
        config,
        sha256(config.canonical),
        context.userId,
        now,
        repository,
      );
      if (!created)
        throw new ConflictError(
          'application_name_taken',
          'An application with this name already exists in the environment.',
        );
      await this.claimDomains(resourceActor(context), created, now);
      await this.audit('created', resourceActor(context), created, now, undefined, read.commitSha);
      return created;
    });
  }

  /**
   * The Git applications a push to `branch` of a repository deploys, with whether each one's
   * environment is protected. Runs in the caller's tenant transaction; checks no permission: a
   * verified delivery of the organization's own App is the system acting.
   */
  followers(
    organizationId: string,
    push: { installationId: number; repositoryId: number; branch: string },
  ): Promise<RepositoryFollower[]> {
    return this.store.followers(organizationId, push);
  }

  /**
   * Makes a configuration read from the repository at `commitSha` the application's, as the
   * system, in the caller's tenant transaction (ADR 0031). The same configuration changes nothing.
   * The name stays the application's, and a domain another application claims is refused, as for
   * any configuration.
   */
  async applyRepositoryConfig(
    organizationId: string,
    applicationId: string,
    text: string,
    commitSha: string,
    now = new Date(),
  ): Promise<Application> {
    const found = await this.store.findById(organizationId, applicationId);
    if (!found || found.source !== 'git' || !(await this.store.lock(found)))
      throw new NotFoundError('application');
    const current = await this.store.findById(organizationId, applicationId);
    if (!current) throw new NotFoundError('application');
    const parsed = parseShipkeepConfig(text);
    if (!parsed.ok)
      throw new InvalidInputError(
        'invalid_application_config',
        `The configuration at ${current.repository?.configPath ?? 'shipkeep.yml'} is invalid.`,
        { issues: parsed.issues.slice(0, 20), commit: commitSha },
      );
    const config = applicationConfig(parsed.config, 'git');
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    assertSameName(current, config);
    const configSha = sha256(config.canonical);
    if (configSha === current.configSha) return current;
    const updated = await this.store.replaceConfig(
      current,
      current.configSha,
      config,
      configSha,
      now,
    );
    if (!updated)
      throw new ConflictError(
        'application_config_changed',
        'The configuration changed meanwhile; reload it and retry.',
      );
    await this.claimDomains(SYSTEM_ACTOR, updated, now);
    await this.audit('updated', SYSTEM_ACTOR, updated, now, current.configSha, commitSha);
    return updated;
  }

  create(
    context: SecurityContext,
    target: ApplicationTarget,
    document: unknown,
    now = new Date(),
  ): Promise<Application> {
    const config = applicationConfig(document);
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    return this.scoped(context, 'deploy.run', target, async () => {
      const created = await this.store.create(
        target,
        config,
        sha256(config.canonical),
        context.userId,
        now,
      );
      if (!created)
        throw new ConflictError(
          'application_name_taken',
          'An application with this name already exists in the environment.',
        );
      await this.claimDomains(resourceActor(context), created, now);
      await this.audit('created', resourceActor(context), created, now);
      return created;
    });
  }

  /** `expectedSha` is the hash the caller edited, so a concurrent change is never overwritten. */
  updateConfig(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    expectedSha: string,
    document: unknown,
    now = new Date(),
  ): Promise<Application> {
    const config = applicationConfig(document);
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    return this.scoped(context, 'deploy.run', target, async () => {
      const found = await this.store.find(target, applicationId);
      // The application's row lock orders this change with a deployment, which takes it before it
      // reads the configuration: a release never snapshots domains this change frees (#302).
      if (!found || !(await this.store.lock(found))) throw new NotFoundError('application');
      const current = await this.store.find(target, applicationId);
      if (!current) throw new NotFoundError('application');
      assertConfigEditable(current);
      assertSameName(current, config);
      const changed = () =>
        new ConflictError(
          'application_config_changed',
          'The configuration changed meanwhile; reload it and retry.',
        );
      if (expectedSha !== current.configSha) throw changed();
      const configSha = sha256(config.canonical);
      // Saving the same configuration changes nothing and records nothing.
      if (configSha === current.configSha) return current;
      const updated = await this.store.replaceConfig(current, expectedSha, config, configSha, now);
      if (!updated) throw changed();
      await this.claimDomains(resourceActor(context), updated, now);
      await this.audit('updated', resourceActor(context), updated, now, current.configSha);
      return updated;
    });
  }

  get(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<Application> {
    return this.scoped(context, 'environment.read', target, async () => {
      const found = await this.store.find(target, applicationId);
      if (!found) throw new NotFoundError('application');
      return found;
    });
  }

  list(context: SecurityContext, target: ApplicationTarget): Promise<Application[]> {
    return this.scoped(context, 'environment.read', target, () => this.store.list(target));
  }

  /**
   * Where the application's domains point, and whether they reach a node running it (PLAN
   * M3.6b1). The application and its hosts are read in one tenant transaction; the lookups run
   * outside it.
   */
  async domains(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<DomainStatus[]> {
    const { application, hosts, readings } = await this.scoped(
      context,
      'environment.read',
      target,
      async () => {
        const found = await this.store.find(target, applicationId);
        if (!found) throw new NotFoundError('application');
        return {
          application: found,
          hosts: await this.store.hosts(found),
          readings: await this.certificates.forApplication(
            found.organizationId,
            found.id,
            new Date(now.getTime() - CERTIFICATE_STALE_MS),
          ),
        };
      },
    );
    return Promise.all(
      (application.config.domains ?? []).map(async (hostname) => ({
        ...domainDns(
          hostname,
          await this.resolver.addresses(hostname),
          isPublicAddress,
          hosts,
          now,
        ),
        certificate: readings.get(hostname),
      })),
    );
  }

  /** A hostname belongs to one application per organization (SPEC 4). */
  private async claimDomains(actor: Actor, application: Application, now: Date): Promise<void> {
    const { taken, released } = await this.store.syncDomains(
      application,
      application.config.domains ?? [],
      now,
    );
    if (taken)
      throw new ConflictError('domain_taken', 'Another application already uses this domain.', {
        hostname: taken,
      });
    if (released.length)
      await this.events.publish(domainsReleased(application, released, actor, now));
  }

  private scoped<T>(
    context: SecurityContext,
    permission: Exclude<Permission, 'profile.read'>,
    target: ApplicationTarget,
    work: () => Promise<T>,
  ): Promise<T> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, permission, scope);
        return this.transaction.runTenant(target.organizationId, work);
      },
      { permission, target: scope },
    );
  }

  private audit(
    action: 'created' | 'updated',
    actor: Actor,
    application: Application,
    now: Date,
    previousSha?: string,
    commitSha?: string,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `application.${action}`,
        organizationId: application.organizationId,
        actor,
        target: { type: 'application', id: application.id },
        // Hashes only: the configuration may carry non-secret values the audit log does not need.
        payload: {
          projectId: application.projectId,
          environmentId: application.environmentId,
          name: application.name,
          source: application.source,
          ...(application.repository
            ? {
                repository: application.repository.fullName,
                repositoryId: application.repository.repositoryId,
                branch: application.repository.branch,
                configPath: application.repository.configPath,
              }
            : {}),
          ...(commitSha ? { commitSha } : {}),
          configSha: application.configSha,
          ...(previousSha ? { previousConfigSha: previousSha } : {}),
        },
        occurredAt: now,
      }),
    ]);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

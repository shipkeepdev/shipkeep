import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, NotFoundError, type Permission } from '@shipkeep/domain';

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
  assertSameName,
  type DomainDns,
  domainDns,
} from '../domain/application';

import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  type ApplicationStore,
  type ApplicationTransaction,
  DOMAIN_RESOLVER,
  type DomainResolver,
} from './ports';

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
  ) {}

  create(
    context: SecurityContext,
    target: ApplicationTarget,
    document: unknown,
    now = new Date(),
  ): Promise<Application> {
    const config = applicationConfig(document);
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
      await this.claimDomains(created, now);
      await this.audit('created', context, created, now);
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
    return this.scoped(context, 'deploy.run', target, async () => {
      const current = await this.store.find(target, applicationId);
      if (!current) throw new NotFoundError('application');
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
      await this.claimDomains(updated, now);
      await this.audit('updated', context, updated, now, current.configSha);
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
  ): Promise<DomainDns[]> {
    const { application, hosts } = await this.scoped(
      context,
      'environment.read',
      target,
      async () => {
        const found = await this.store.find(target, applicationId);
        if (!found) throw new NotFoundError('application');
        return { application: found, hosts: await this.store.hosts(found) };
      },
    );
    return Promise.all(
      (application.config.domains ?? []).map(async (hostname) =>
        domainDns(hostname, await this.resolver.addresses(hostname), isPublicAddress, hosts, now),
      ),
    );
  }

  /** A hostname belongs to one application per organization (SPEC 4). */
  private async claimDomains(application: Application, now: Date): Promise<void> {
    const taken = await this.store.syncDomains(application, application.config.domains ?? [], now);
    if (taken)
      throw new ConflictError('domain_taken', 'Another application already uses this domain.', {
        hostname: taken,
      });
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
    context: SecurityContext,
    application: Application,
    now: Date,
    previousSha?: string,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `application.${action}`,
        organizationId: application.organizationId,
        actor: resourceActor(context),
        target: { type: 'application', id: application.id },
        // Hashes only: the configuration may carry non-secret values the audit log does not need.
        payload: {
          projectId: application.projectId,
          environmentId: application.environmentId,
          name: application.name,
          source: application.source,
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

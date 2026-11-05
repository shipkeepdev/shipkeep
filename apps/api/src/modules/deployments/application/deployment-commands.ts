import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  createEvent,
  type DomainEvent,
  NotFoundError,
  type Permission,
  stop,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { Application, ApplicationTarget } from '../../apps/domain/application';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { SECRET_STORE, type SecretStore } from '../../secrets/application/ports';
import {
  assertSecretsSet,
  type DeploymentRecord,
  deploymentInProgress,
  type Release,
  releaseDraft,
} from '../domain/release';

import {
  DEPLOYMENT_STORE,
  DEPLOYMENT_TRANSACTION,
  type DeploymentStore,
  type DeploymentTransaction,
} from './ports';

const CANCELLED_BY_USER = 'Cancelled by a user.';

/**
 * Releases and deployments of an application (SPEC 4 and 5.1, PLAN M3.4b2). Deploying snapshots
 * the application's configuration as a release and queues a deployment; the pipeline that moves
 * it forward is M3.4c. Deploying and cancelling need `deploy.run`; reading needs
 * `environment.read`.
 */
@Injectable()
export class DeploymentCommands {
  constructor(
    @Inject(DEPLOYMENT_STORE) private readonly store: DeploymentStore,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  deploy(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<{ release: Release; deployment: DeploymentRecord }> {
    return this.scoped(context, 'deploy.run', target, applicationId, async (application) => {
      const draft = releaseDraft(application.config);
      const set = await this.secrets.list(target);
      assertSecretsSet(
        draft.secrets,
        set.map((secret) => secret.name),
      );
      const running = await this.store.active(application.id);
      if (running) throw deploymentInProgress(running.state);
      const release = await this.store.createRelease(application, draft, context.userId, now);
      if (!release) throw deploymentInProgress();
      const deployment = await this.store.queue(release, draft, 'manual', context.userId, now);
      if (!deployment) throw deploymentInProgress();
      await this.events.publish([
        this.event('release.created', context, application, release.id, now, {
          number: release.number,
          image: release.image,
          configSha: release.configSha,
        }),
        this.event('deployment.queued', context, application, deployment.id, now, {
          releaseId: release.id,
          trigger: deployment.trigger,
        }),
      ]);
      return { release, deployment };
    });
  }

  /** Cancels an unfinished deployment; the pipeline (M3.4c) restores routing if needed. */
  cancel(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    deploymentId: string,
    now = new Date(),
  ): Promise<DeploymentRecord> {
    return this.scoped(context, 'deploy.run', target, applicationId, async (application) => {
      const current = await this.store.find(application.id, deploymentId);
      if (!current) throw new NotFoundError('deployment');
      const stopped = stop(current, 'cancelled', CANCELLED_BY_USER, now);
      const cancelled: DeploymentRecord = { ...current, ...stopped.deployment };
      if (!(await this.store.finish(cancelled, current.state, now)))
        throw new ConflictError(
          'deployment_changed',
          'The deployment changed meanwhile; reload it and retry.',
        );
      await this.events.publish([
        this.event('deployment.cancelled', context, application, cancelled.id, now, {
          releaseId: cancelled.releaseId,
          from: current.state,
          routing: stopped.routing,
        }),
      ]);
      return cancelled;
    });
  }

  list(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<DeploymentRecord[]> {
    return this.scoped(context, 'environment.read', target, applicationId, (application) =>
      this.store.list(application.id),
    );
  }

  get(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord> {
    return this.scoped(context, 'environment.read', target, applicationId, async (application) => {
      const found = await this.store.find(application.id, deploymentId);
      if (!found) throw new NotFoundError('deployment');
      return found;
    });
  }

  releases(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<Release[]> {
    return this.scoped(context, 'environment.read', target, applicationId, (application) =>
      this.store.releases(application.id),
    );
  }

  /** Checks the live permission, then resolves the application inside its environment. */
  private scoped<T>(
    context: SecurityContext,
    permission: Exclude<Permission, 'profile.read'>,
    target: ApplicationTarget,
    applicationId: string,
    work: (application: Application) => Promise<T>,
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
        return this.transaction.runTenant(target.organizationId, async () => {
          const application = await this.applications.find(target, applicationId);
          if (!application) throw new NotFoundError('application');
          return work(application);
        });
      },
      { permission, target: scope },
    );
  }

  private event(
    type: 'release.created' | 'deployment.queued' | 'deployment.cancelled',
    context: SecurityContext,
    application: Application,
    id: string,
    now: Date,
    payload: Record<string, string | number>,
  ): DomainEvent {
    return createEvent({
      type,
      organizationId: application.organizationId,
      actor: resourceActor(context),
      target: { type: type.split('.')[0] ?? 'deployment', id },
      payload: {
        projectId: application.projectId,
        environmentId: application.environmentId,
        applicationId: application.id,
        ...payload,
      },
      occurredAt: now,
    });
  }
}

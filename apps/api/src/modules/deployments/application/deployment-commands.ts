import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  createEvent,
  type DomainEvent,
  type MaintenanceChange,
  NotFoundError,
  type Permission,
  type Secret,
  stop,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  APPLICATION_STORE,
  type ApplicationStore,
  CONTROL_PLANE_HOST,
} from '../../apps/application/ports';
import {
  type Application,
  type ApplicationTarget,
  assertConfigApplied,
  assertDomainsAvailable,
} from '../../apps/domain/application';
import { domainsReleased } from '../../apps/domain/domain-events';
import { ConfirmationVerifier } from '../../confirmations/application/confirmation-verifier';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { SECRET_STORE, type SecretStore } from '../../secrets/application/ports';
import { MAX_DEPLOYMENT_ACTIONS } from '../../fleet/application/agent-actions';
import type { AgentActionView } from '../../fleet/domain/agent-action';
import {
  agentsWithoutMaintenancePage,
  applicationInMaintenance,
  inMaintenance,
  maintenanceAlreadyOn,
  maintenanceDraft,
  maintenanceNotOn,
  maintenanceWithoutDomain,
  maintenanceWithoutReplica,
  servesMaintenancePage,
} from '../domain/maintenance';
import type { NodeReplica, ReplicaStatus } from '../domain/observations';
import { deploymentSteps, type DeploymentStep, MAX_STEPS } from '../domain/timeline';
import {
  applicationNotRunning,
  applicationRunning,
  assertRollbackTarget,
  assertSecretsSet,
  type DeploymentRecord,
  deploymentInProgress,
  type Release,
  releaseDraft,
  rollbackDraft,
  stopDraft,
} from '../domain/release';

import {
  ACTION_HISTORY,
  DEPLOYMENT_STEPS,
  type DeploymentStepStore,
  type ActionHistory,
  DEPLOYMENT_STORE,
  DEPLOYMENT_TRANSACTION,
  DEPLOYMENT_WAKER,
  type DeploymentStore,
  type DeploymentTransaction,
  type DeploymentWaker,
  OBSERVATION_STORE,
  type ObservationStore,
  PIPELINE_STORE,
  type PipelineStore,
} from './ports';

const CANCELLED_BY_USER = 'Cancelled by a user.';
/** Replicas a server's page lists at most (#264). */
export const NODE_REPLICAS = 200;

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
    @Inject(DEPLOYMENT_WAKER) private readonly waker: DeploymentWaker,
    @Inject(OBSERVATION_STORE) private readonly observations: ObservationStore,
    @Inject(ACTION_HISTORY) private readonly actionHistory: ActionHistory,
    @Inject(DEPLOYMENT_STEPS) private readonly steps: DeploymentStepStore,
    @Inject(PIPELINE_STORE) private readonly pipeline: PipelineStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly confirmations: ConfirmationVerifier,
    private readonly events: DomainEventBus,
    @Inject(CONTROL_PLANE_HOST) private readonly controlPlaneHost: string,
  ) {}

  deploy(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<{ release: Release; deployment: DeploymentRecord }> {
    return this.scoped(
      context,
      'deploy.run',
      target,
      applicationId,
      async (application) => {
        // A configuration saved before the control plane's name was refused is refused here, and so
        // is one saved before the fields no deployment applies were refused.
        assertDomainsAvailable(application.config, [this.controlPlaneHost]);
        assertConfigApplied(application.config);
        const draft = releaseDraft(application.config);
        const set = await this.secrets.list(target);
        assertSecretsSet(
          draft.secrets,
          set.map((secret) => secret.name),
        );
        const running = await this.store.active(application.id);
        if (running) throw deploymentInProgress(running.state);
        // A new release would start behind the page unseen: leaving maintenance comes first.
        if (inMaintenance(await this.store.serving(application.id)))
          throw applicationInMaintenance();
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
        // The pipeline run commits with the deployment (PLAN M3.4c4c).
        await this.waker.wake(application.organizationId, deployment.id);
        return { release, deployment };
      },
      true,
    );
  }

  /** Deploys a copy of the release an earlier deployment ran (SPEC 5.1, PLAN M3.5a). */
  rollback(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    deploymentId: string,
    now = new Date(),
  ): Promise<{ release: Release; deployment: DeploymentRecord }> {
    return this.scoped(
      context,
      'deploy.run',
      target,
      applicationId,
      async (application) => {
        const previous = await this.store.find(application.id, deploymentId);
        if (!previous) throw new NotFoundError('deployment');
        const serving = await this.store.serving(application.id);
        if (inMaintenance(serving)) throw applicationInMaintenance();
        assertRollbackTarget(previous, serving);
        const source = await this.store.release(application.id, previous.releaseId);
        if (!source) throw new NotFoundError('release');
        assertDomainsAvailable(source.config, [this.controlPlaneHost]);
        const draft = rollbackDraft(source);
        const set = await this.secrets.list(target);
        assertSecretsSet(
          draft.secrets,
          set.map((secret) => secret.name),
        );
        const running = await this.store.active(application.id);
        if (running) throw deploymentInProgress(running.state);
        // The older configuration may name a domain another application has claimed since. The
        // current domains stay claimed: the next deployment uses them again.
        const { taken, released } = await this.applications.syncDomains(
          application,
          [...new Set([...(application.config.domains ?? []), ...(source.config.domains ?? [])])],
          now,
        );
        if (taken)
          throw new ConflictError('domain_taken', 'Another application already uses this domain.', {
            hostname: taken,
          });
        if (released.length)
          await this.events.publish(
            domainsReleased(application, released, resourceActor(context), now),
          );
        const release = await this.store.copyRelease(source, context.userId, now);
        if (!release) throw deploymentInProgress();
        const deployment = await this.store.queue(release, draft, 'rollback', context.userId, now);
        if (!deployment) throw deploymentInProgress();
        await this.events.publish([
          this.event('release.created', context, application, release.id, now, {
            number: release.number,
            image: release.image,
            configSha: release.configSha,
            rollbackOf: source.number,
          }),
          this.event('deployment.queued', context, application, deployment.id, now, {
            releaseId: release.id,
            trigger: deployment.trigger,
          }),
        ]);
        await this.waker.wake(application.organizationId, deployment.id);
        return { release, deployment };
      },
      true,
    );
  }

  /**
   * Stops the application (SPEC 5.1, issue #256): queues a deployment that starts nothing and
   * removes the routes and the placed replicas, which frees what they reserve on their nodes.
   * The application, its releases and its history stay; deploying again starts it.
   */
  stop(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<DeploymentRecord> {
    return this.scoped(context, 'deploy.run', target, applicationId, async (application) => {
      const running = await this.store.active(application.id);
      if (running) throw deploymentInProgress(running.state);
      // Placed replicas, not the last success: a deployment that failed while draining left its
      // new replicas serving, and they must be stoppable too.
      const replicas = await this.observations.forApplication(application.id);
      const placed = replicas.at(0);
      if (!placed) throw applicationNotRunning();
      const release = await this.store.release(application.id, placed.releaseId);
      if (!release) throw new NotFoundError('release');
      const deployment = await this.store.queue(
        release,
        stopDraft(release),
        'manual',
        context.userId,
        now,
      );
      if (!deployment) throw deploymentInProgress();
      await this.events.publish([
        this.event('deployment.queued', context, application, deployment.id, now, {
          releaseId: release.id,
          trigger: deployment.trigger,
          plan: 'stop',
        }),
      ]);
      await this.waker.wake(application.organizationId, deployment.id);
      return deployment;
    });
  }

  /**
   * Puts the application in maintenance (ADR 0025, issue #256): queues a deployment of the release
   * that runs whose routes serve the agent's maintenance page, while the replicas keep running.
   */
  enterMaintenance(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<DeploymentRecord> {
    return this.changeMaintenance(context, target, applicationId, 'enter', now);
  }

  /** Takes the application out of maintenance: its routes serve its replicas again (ADR 0025). */
  leaveMaintenance(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    now = new Date(),
  ): Promise<DeploymentRecord> {
    return this.changeMaintenance(context, target, applicationId, 'leave', now);
  }

  /**
   * Refused while another deployment runs, when the application already is (or is not) in
   * maintenance, and when no replica runs. Entering is also refused when the application has no
   * domain, so no route to show the page on, and when an agent that hosts a replica predates the
   * page. Locked like a deployment, so the two cannot pass their checks at the same time.
   */
  private changeMaintenance(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    change: MaintenanceChange,
    now: Date,
  ): Promise<DeploymentRecord> {
    return this.scoped(
      context,
      'deploy.run',
      target,
      applicationId,
      async (application) => {
        const running = await this.store.active(application.id);
        if (running) throw deploymentInProgress(running.state);
        const on = inMaintenance(await this.store.serving(application.id));
        if (change === 'enter' && on) throw maintenanceAlreadyOn();
        if (change === 'leave' && !on) throw maintenanceNotOn();
        const replicas = await this.observations.forApplication(application.id);
        const placed = replicas.at(0);
        if (!placed) throw maintenanceWithoutReplica();
        const release = await this.store.release(application.id, placed.releaseId);
        if (!release) throw new NotFoundError('release');
        if (change === 'enter') {
          if (!release.config.domains?.length) throw maintenanceWithoutDomain();
          const hosting = new Set(replicas.map((replica) => replica.nodeId));
          const outdated = (await this.pipeline.nodes(application.organizationId)).filter(
            (node) => hosting.has(node.id) && !servesMaintenancePage(node.facts['agent_version']),
          );
          if (outdated.length)
            throw agentsWithoutMaintenancePage(outdated.map((node) => node.name));
        }
        const deployment = await this.store.queue(
          release,
          maintenanceDraft(release, change),
          'manual',
          context.userId,
          now,
        );
        if (!deployment) throw deploymentInProgress();
        await this.events.publish([
          this.event('deployment.queued', context, application, deployment.id, now, {
            releaseId: release.id,
            trigger: deployment.trigger,
            plan: change === 'enter' ? 'maintenance_enter' : 'maintenance_leave',
          }),
        ]);
        await this.waker.wake(application.organizationId, deployment.id);
        return deployment;
      },
      true,
    );
  }

  /**
   * Deletes an application (SPEC 3.6, issue #256). Destructive: it needs `environment.update` on
   * the application's environment and a confirmation token for this exact application, spent in
   * the same transaction. Refused while a deployment runs or a replica is placed, so no container
   * is left behind on a server: stop the application first. Its releases, deployments and
   * claimed domains go with it; the audit log and the servers' action history stay.
   */
  remove(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    confirmation: Secret,
    now = new Date(),
  ): Promise<void> {
    return this.scoped(
      context,
      'environment.update',
      target,
      applicationId,
      async (application) => {
        // Locked first: a deployment queued at this moment is then either seen or refused.
        if (!(await this.applications.lock(application))) throw new NotFoundError('application');
        const running = await this.store.active(application.id);
        if (running) throw deploymentInProgress(running.state);
        if ((await this.observations.forApplication(application.id)).length)
          throw applicationRunning();
        const confirmationId = await this.confirmations.consume(
          confirmation,
          {
            organizationId: application.organizationId,
            action: 'application.delete',
            target: application.id,
          },
          context.userId,
          now,
        );
        if (!(await this.applications.delete(application))) throw new NotFoundError('application');
        await this.events.publish([
          this.event('application.deleted', context, application, application.id, now, {
            name: application.name,
            confirmationId,
          }),
        ]);
      },
    );
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
      if (!(await this.store.transition(cancelled, current.state, now)))
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
      // A cancelled deployment no longer routes its snapshot: what nothing placed serves is free
      // (#302). Replicas it placed keep their domains until the cleanup stops them.
      const released = await this.applications.releaseUnservedDomains(application);
      if (released.length)
        await this.events.publish(
          domainsReleased(application, released, resourceActor(context), now),
        );
      await this.waker.wake(application.organizationId, cancelled.id);
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

  /**
   * What one deployment went through (#265): its audited state changes and the agent actions it
   * requested, oldest first. `truncated` says more actions exist than listed.
   */
  timeline(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    deploymentId: string,
  ): Promise<{ steps: DeploymentStep[]; actions: AgentActionView[]; truncated: boolean }> {
    return this.scoped(context, 'environment.read', target, applicationId, async (application) => {
      const found = await this.store.find(application.id, deploymentId);
      if (!found) throw new NotFoundError('deployment');
      const [events, actions] = await Promise.all([
        this.steps.events(application.organizationId, found.id, MAX_STEPS),
        this.actionHistory.forDeployment(
          application.organizationId,
          found.id,
          MAX_DEPLOYMENT_ACTIONS + 1,
        ),
      ]);
      return {
        steps: deploymentSteps(events),
        actions: actions.slice(0, MAX_DEPLOYMENT_ACTIONS),
        truncated: actions.length > MAX_DEPLOYMENT_ACTIONS,
      };
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

  replicas(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<ReplicaStatus[]> {
    return this.scoped(context, 'environment.read', target, applicationId, (application) =>
      this.observations.forApplication(application.id),
    );
  }

  /**
   * The replicas placed on a server, at most `NODE_REPLICAS`, with the application, project and
   * environment of each (#264). It needs `node.manage`, which only owners and admins hold, and
   * they read every environment of the organization. `truncated` says more replicas exist.
   */
  nodeReplicas(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
  ): Promise<{ items: NodeReplica[]; truncated: boolean }> {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'node.manage', { organizationId });
      const found = await this.transaction.runTenant(organizationId, () =>
        this.observations.onNode(organizationId, nodeId, NODE_REPLICAS + 1),
      );
      if (!found) throw new NotFoundError('resource');
      return { items: found.slice(0, NODE_REPLICAS), truncated: found.length > NODE_REPLICAS };
    });
  }

  /**
   * The agent actions the application's deployments requested, newest first, including the
   * ones agents refused (issue #263). `nextCursor` is null on the last page.
   */
  actions(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: AgentActionView[]; nextCursor: string | null }> {
    return this.scoped(context, 'environment.read', target, applicationId, async (application) => {
      const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
      // One more row than the page tells whether another page exists.
      const rows = await this.actionHistory.history(
        application.organizationId,
        application.id,
        cursor,
        size + 1,
      );
      const items = rows.slice(0, size);
      return { items, nextCursor: rows.length > size ? (items.at(-1)?.id ?? null) : null };
    });
  }

  /** Checks the live permission, then resolves the application inside its environment. */
  private scoped<T>(
    context: SecurityContext,
    permission: Exclude<Permission, 'profile.read'>,
    target: ApplicationTarget,
    applicationId: string,
    work: (application: Application) => Promise<T>,
    lock = false,
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
          const found = await this.applications.find(target, applicationId);
          if (!found) throw new NotFoundError('application');
          if (!lock) return work(found);
          // Locked, then read again: the configuration a release snapshots is the one a
          // concurrent change committed, never one that change has just replaced (#302).
          if (!(await this.applications.lock(found))) throw new NotFoundError('application');
          const application = await this.applications.find(target, applicationId);
          if (!application) throw new NotFoundError('application');
          return work(application);
        });
      },
      { permission, target: scope },
    );
  }

  private event(
    type: 'release.created' | 'deployment.queued' | 'deployment.cancelled' | 'application.deleted',
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

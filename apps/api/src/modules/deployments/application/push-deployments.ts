import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createEvent, isDomainError, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { ApplicationCommands } from '../../apps/application/application-commands';
import {
  REPOSITORY_SOURCE,
  type RepositoryConfig,
  type RepositorySource,
} from '../../apps/application/ports';
import type { Application } from '../../apps/domain/application';
import type { PushEvent } from '../../git/domain/github-webhook';

import { DeploymentCommands } from './deployment-commands';
import { DEPLOYMENT_TRANSACTION, type DeploymentTransaction } from './ports';

/**
 * Verified pushes become deployments (ADR 0031, #213). For each Git application that follows the
 * pushed branch, GitHub is asked for the branch's head: only while the pushed commit is still that
 * head is its shipkeep.yml read and made the application's, and the commit deployed. A replayed or
 * overtaken push therefore deploys nothing. GitHub is asked outside any transaction.
 */
@Injectable()
export class PushDeployments {
  private readonly logger = new Logger(PushDeployments.name);

  constructor(
    @Inject(REPOSITORY_SOURCE) private readonly sources: RepositorySource,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    private readonly applications: ApplicationCommands,
    private readonly deployments: DeploymentCommands,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Handles a push for the applications that follow its branch, or only those named in `only`
   * (a push tried again). Answers the applications to try again later: GitHub unavailable, or a
   * deployment already under way.
   */
  async handle(push: PushEvent, only?: readonly string[], now = new Date()): Promise<string[]> {
    const followers = await this.transaction.runTenant(push.organizationId, () =>
      this.applications.followers(push.organizationId, push),
    );
    const again: string[] = [];
    for (const { application, protectedEnvironment } of followers) {
      if (only && !only.includes(application.id)) continue;
      if (!application.repository) continue;
      let read: RepositoryConfig;
      try {
        read = await this.sources.read(push.organizationId, application.repository);
      } catch (error: unknown) {
        if (error instanceof ServiceUnavailableException) again.push(application.id);
        else await this.refused(push, application, error, now);
        continue;
      }
      // Only the branch's current head deploys.
      if (read.commitSha !== push.commit) continue;
      try {
        const outcome = await this.transaction.runTenant(push.organizationId, async () => {
          const current = await this.applications.applyRepositoryConfig(
            push.organizationId,
            application.id,
            read.text,
            read.commitSha,
            now,
          );
          return this.deployments.deployPush(current, push, protectedEnvironment, now);
        });
        if (outcome === 'busy') again.push(application.id);
      } catch (error: unknown) {
        await this.refused(push, application, error, now);
      }
    }
    return again;
  }

  /**
   * A push that cannot deploy is audited with the reason's stable code, never its text. An error
   * that is not a domain one is rethrown: the job fails and pg-boss tries it again.
   */
  private async refused(
    push: PushEvent,
    application: Application,
    error: unknown,
    now: Date,
  ): Promise<void> {
    if (!isDomainError(error)) throw error;
    this.logger.warn({ applicationId: application.id, code: error.code }, 'push not deployed');
    await this.transaction.runTenant(push.organizationId, () =>
      this.events.publish([
        createEvent({
          type: 'deployment.push_refused',
          organizationId: push.organizationId,
          actor: SYSTEM_ACTOR,
          target: { type: 'application', id: application.id },
          payload: {
            projectId: application.projectId,
            environmentId: application.environmentId,
            applicationId: application.id,
            commitSha: push.commit,
            githubPusher: push.pusher,
            code: error.code,
          },
          occurredAt: now,
        }),
      ]),
    );
  }
}

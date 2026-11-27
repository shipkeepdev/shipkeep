import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createEvent, isDomainError, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { ApplicationCommands } from '../../apps/application/application-commands';
import {
  type FollowerPage,
  MAX_FOLLOWERS,
  REPOSITORY_SOURCE,
  type RepositoryConfig,
  type RepositorySource,
} from '../../apps/application/ports';
import type { Application } from '../../apps/domain/application';
import type { PushEvent } from '../../git/domain/github-webhook';
import { pushGivenUp } from '../domain/release';

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
   * Handles a page of the applications that follow the push's branch: the first, the one after
   * `page.after`, or only those named in `page.only` (a push tried again). Answers the
   * applications to try again later (GitHub unavailable, a deployment under way, another push
   * applied meanwhile) and, when the page was full, the last one, after which the next page
   * starts.
   */
  async handle(
    push: PushEvent,
    page: FollowerPage = {},
    now = new Date(),
  ): Promise<{ again: string[]; next?: string }> {
    const followers = await this.transaction.runTenant(push.organizationId, () =>
      this.applications.followers(push.organizationId, push, page),
    );
    const again: string[] = [];
    for (const application of followers) {
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
            application,
            read,
            now,
          );
          if (current === 'moved') return current;
          return this.deployments.deployPush(
            current.application,
            push,
            current.protectedEnvironment,
            now,
          );
        });
        if (outcome === 'busy' || outcome === 'moved') again.push(application.id);
      } catch (error: unknown) {
        // A deployment queued at the same moment: nothing was kept, the push waits its turn.
        if (isDomainError(error) && error.code === 'deployment_in_progress')
          again.push(application.id);
        else await this.refused(push, application, error, now);
      }
    }
    const last = followers.at(-1);
    return !page.only && last && followers.length === MAX_FOLLOWERS
      ? { again, next: last.id }
      : { again };
  }

  /**
   * The applications a push was tried for too long without deploying: each is audited as
   * refused, so the log says the commit never deployed. Those deleted meanwhile are skipped.
   */
  async gaveUp(
    push: PushEvent,
    applicationIds: readonly string[],
    now = new Date(),
  ): Promise<void> {
    const followers = await this.transaction.runTenant(push.organizationId, () =>
      this.applications.followers(push.organizationId, push, { only: applicationIds }),
    );
    for (const application of followers) await this.refused(push, application, pushGivenUp(), now);
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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEvent, isTenantId, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { REGISTRY_STORAGE, type RegistryStorage } from '../../registries/application/ports';
import { keptTags } from '../domain/retention';

import {
  DEPLOYMENT_TRANSACTION,
  type DeploymentTransaction,
  RETENTION_STORE,
  type RetentionStore,
} from './ports';

/** Repositories read per page of the registry's catalog, and at most in one run. */
const CATALOG_PAGE = 100;
const MAX_REPOSITORIES = 100_000;
/** An application's repository: `<organization>/<application>` (ADR 0030). */
const APPLICATION_REPOSITORY = /^([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

/**
 * Removes from the installation's registry the images no rollback can reach and no deployment
 * needs (ADR 0030): of each application's repository, every manifest that no kept tag names, and
 * the whole repository of an application that no longer exists. Distribution's garbage
 * collection frees their layers afterwards. Every removal for an application is audited.
 */
@Injectable()
export class ImageRetention {
  private readonly logger = new Logger(ImageRetention.name);

  constructor(
    @Inject(REGISTRY_STORAGE) private readonly registry: RegistryStorage,
    @Inject(RETENTION_STORE) private readonly store: RetentionStore,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    private readonly events: DomainEventBus,
  ) {}

  /** One pass over the registry; a repository that fails is left for the next one. */
  async run(now = new Date()): Promise<{ repositories: number; deleted: number }> {
    let last: string | undefined;
    let repositories = 0;
    let deleted = 0;
    while (repositories < MAX_REPOSITORIES) {
      const page = await this.registry.repositories(last, CATALOG_PAGE);
      // The catalog ends with an empty page: a short one may come before the end.
      const next = page.at(-1);
      if (next === undefined || next === last) break;
      for (const repository of page) {
        repositories++;
        try {
          deleted += await this.prune(repository, now);
        } catch {
          // Errors may carry the registry's or the driver's details: never log them.
          this.logger.warn({ repository }, 'image retention skipped a repository');
        }
      }
      last = next;
    }
    return { repositories, deleted };
  }

  /**
   * Removes the tags no kept release runs. The tags are read before the releases: the release of
   * any tag read exists already, since a release is recorded before its build pushes. Only tags
   * go, never a manifest: one that another tag names stays, even a tag pushed after this read
   * (a build in progress, whose release is kept), and the registry's garbage collection removes
   * the manifests no tag names. A deployment queued after the read is a new release, with a tag of
   * its own, or a rollback to the release before the one that serves, which is kept.
   */
  private async prune(repository: string, now: Date): Promise<number> {
    const named = APPLICATION_REPOSITORY.exec(repository);
    const organizationId = named?.[1];
    const applicationId = named?.[2];
    if (
      !organizationId ||
      !applicationId ||
      !isTenantId(organizationId) ||
      !isTenantId(applicationId)
    )
      return 0;
    const tags = await this.registry.tags(repository);
    if (!tags.length) return 0;
    const application = await this.transaction.runTenant(organizationId, () =>
      this.store.releases(applicationId),
    );
    const kept = keptTags(application?.releases ?? [], repository);
    const removed: string[] = [];
    for (const tag of tags) {
      if (kept.has(tag)) continue;
      // One tag that fails does not stop the others, nor the record of those removed.
      try {
        if (await this.registry.deleteTag(repository, tag)) removed.push(tag);
      } catch {
        this.logger.warn({ repository }, 'image retention could not remove a tag');
      }
    }
    removed.sort();
    if (removed.length && application) {
      try {
        await this.transaction.runTenant(organizationId, () =>
          this.events.publish([
            createEvent({
              type: 'application.images_pruned',
              organizationId,
              actor: SYSTEM_ACTOR,
              target: { type: 'application', id: applicationId },
              payload: {
                projectId: application.projectId,
                environmentId: application.environmentId,
                applicationId,
                tags: removed.join(','),
                count: removed.length,
              },
              occurredAt: now,
            }),
          ]),
        );
      } catch {
        // The registry has changed and cannot change back: the log keeps what the audit could not.
        this.logger.error(
          { repository, tags: removed.join(','), count: removed.length },
          'image retention removed tags it could not audit',
        );
      }
    }
    if (removed.length && !application)
      this.logger.log(
        { repository, count: removed.length },
        'removed the images of a deleted application',
      );
    return removed.length;
  }
}

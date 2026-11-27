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
      for (const repository of page) {
        repositories++;
        try {
          deleted += await this.prune(repository, now);
        } catch {
          // Errors may carry the registry's or the driver's details: never log them.
          this.logger.warn({ repository }, 'image retention skipped a repository');
        }
      }
      if (page.length < CATALOG_PAGE) break;
      last = page.at(-1);
    }
    return { repositories, deleted };
  }

  /**
   * The tags are read before the releases: a tag pushed meanwhile is not read at all, and the
   * release of any tag read already exists, since a release is recorded before its build pushes.
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
    const digests = new Map<string, string>();
    for (const tag of await this.registry.tags(repository)) {
      const digest = await this.registry.digest(repository, tag);
      if (digest) digests.set(tag, digest);
    }
    if (!digests.size) return 0;
    const application = await this.transaction.runTenant(organizationId, () =>
      this.store.releases(applicationId),
    );
    const kept = keptTags(application?.releases ?? []);
    // A manifest a kept tag names stays, whatever other tags name it too.
    const keep = new Set([...digests].filter(([tag]) => kept.has(tag)).map(([, digest]) => digest));
    const removed: string[] = [];
    for (const digest of new Set(digests.values())) {
      if (keep.has(digest)) continue;
      if (await this.registry.deleteManifest(repository, digest))
        removed.push(...[...digests].filter(([, named]) => named === digest).map(([tag]) => tag));
    }
    if (removed.length && application)
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
              tags: removed.sort().join(','),
              count: removed.length,
            },
            occurredAt: now,
          }),
        ]),
      );
    if (removed.length && !application)
      this.logger.log(
        { repository, count: removed.length },
        'removed the images of a deleted application',
      );
    return removed.length;
  }
}

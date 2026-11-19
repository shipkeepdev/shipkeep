import { createEvent, type Actor, type DomainEvent } from '@shipkeep/domain';
import type { Application } from './application';

/**
 * One audit event per domain reservation an application gave up (#302). The hostname goes in
 * the payload: it can be longer than an audit target id.
 */
export function domainsReleased(
  application: Pick<Application, 'id' | 'organizationId' | 'projectId' | 'environmentId'>,
  hostnames: readonly string[],
  actor: Actor,
  now: Date,
): DomainEvent[] {
  return hostnames.map((hostname) =>
    createEvent({
      type: 'domain.released',
      organizationId: application.organizationId,
      actor,
      target: { type: 'application', id: application.id },
      payload: {
        projectId: application.projectId,
        environmentId: application.environmentId,
        applicationId: application.id,
        hostname,
      },
      occurredAt: now,
    }),
  );
}

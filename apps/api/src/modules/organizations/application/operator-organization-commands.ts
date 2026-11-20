import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  createEvent,
  organizationSettings,
  type OrganizationSettingsInput,
  SYSTEM_ACTOR,
} from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';

import {
  ORGANIZATION_STORE,
  type OrganizationRecord,
  type OrganizationStore,
} from './organization-store';

/**
 * Organizations created on the server that runs the control plane (ADR 0021): the single-machine
 * installer creates the first one for the account it created (ADR 0020). No route reaches this:
 * it runs from the command line of the control plane (`operator.ts`), by someone who already
 * holds the database and the key-encryption key. The audit names the system as actor.
 *
 * Given an `id`, creating is idempotent: the installer chooses the id and records it before the
 * call, so that a run interrupted after the commit finds the same organization again.
 */
@Injectable()
export class OperatorOrganizationCommands {
  constructor(
    @Inject(ORGANIZATION_STORE) private readonly store: OrganizationStore,
    private readonly events: DomainEventBus,
  ) {}

  async create(
    input: OrganizationSettingsInput,
    ownerId: string,
    now = new Date(),
    id?: string,
  ): Promise<OrganizationRecord> {
    const organization = {
      ...organizationSettings(input),
      id: id ?? uuidv7(),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(organization.id, async () => {
      if (id !== undefined) {
        // Read in that organization's own tenant context, as row security requires.
        const existing = await this.existing(id, ownerId, organization.slug);
        if (existing) return existing;
      }
      try {
        await this.store.create(organization, ownerId);
      } catch (error: unknown) {
        // A concurrent call with the same id committed first: its organization is this one.
        const existing =
          id === undefined ? undefined : await this.existing(id, ownerId, organization.slug);
        if (existing) return existing;
        throw error;
      }
      await this.events.publish([
        createEvent({
          type: 'organization.created',
          occurredAt: now,
          organizationId: organization.id,
          actor: SYSTEM_ACTOR,
          target: { type: 'organization', id: organization.id },
          payload: { name: organization.name, slug: organization.slug, ownerId },
        }),
      ]);
      return organization;
    });
  }

  /** The organization with this id owned by the owner, refused when its slug is another. */
  private async existing(
    id: string,
    ownerId: string,
    slug: string,
  ): Promise<OrganizationRecord | undefined> {
    const existing = await this.store.ownedBy(id, ownerId);
    if (existing && existing.slug !== slug)
      throw new ConflictError(
        'organization_id_taken',
        'An organization with this id already exists with another slug.',
      );
    return existing;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
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
  ): Promise<OrganizationRecord> {
    const organization = {
      ...organizationSettings(input),
      id: uuidv7(),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.transaction(organization.id, async () => {
      await this.store.create(organization, ownerId);
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
    });
    return organization;
  }
}

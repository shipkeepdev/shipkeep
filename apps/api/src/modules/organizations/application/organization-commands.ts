import { Inject, Injectable } from '@nestjs/common';
import {
  createEvent,
  organizationSettings,
  type OrganizationSettingsInput,
  type Secret,
} from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import type { MfaProofInput } from '../../identity/application/mfa-crypto';
import type { SessionGrant } from '../../identity/application/session-commands';

import {
  ORGANIZATION_STORE,
  type OrganizationRecord,
  type OrganizationStore,
} from './organization-store';
import { TenantAccess } from './tenant-access';

@Injectable()
export class OrganizationCommands {
  constructor(
    @Inject(ORGANIZATION_STORE) private readonly store: OrganizationStore,
    private readonly authority: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  async create(
    context: SecurityContext,
    input: OrganizationSettingsInput,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<{ organization: OrganizationRecord; session: SessionGrant }> {
    const organization = {
      ...organizationSettings(input),
      id: uuidv7(),
      createdAt: now,
      updatedAt: now,
    };
    return this.authority.reauthenticated(
      context,
      password,
      factor,
      () =>
        this.store.transaction(organization.id, async () => {
          await this.store.create(organization, context.userId);
          await this.audit('organization.created', context, organization, now);
          const session = await this.authority.rotate(context, now);
          return { organization, session };
        }),
      now,
    );
  }

  async update(
    context: SecurityContext,
    organizationId: string,
    input: OrganizationSettingsInput,
    now = new Date(),
  ): Promise<OrganizationRecord> {
    const settings = organizationSettings(input);
    return this.authority.run(
      context,
      () =>
        this.store.transaction(organizationId, async () => {
          await this.access.require(context.userId, 'organization.update', { organizationId });
          const organization = await this.store.update(organizationId, settings, now);
          await this.audit('organization.updated', context, organization, now);
          return organization;
        }),
      { permission: 'organization.update', target: { organizationId } },
    );
  }

  private async audit(
    type: string,
    context: SecurityContext,
    organization: OrganizationRecord,
    now: Date,
  ): Promise<void> {
    await this.events.publish([
      createEvent({
        type,
        occurredAt: now,
        organizationId: organization.id,
        actor: resourceActor(context),
        target: { type: 'organization', id: organization.id },
        payload: {
          name: organization.name,
          slug: organization.slug,
          ...(type === 'organization.created' ? { ownerId: context.userId } : {}),
        },
      }),
    ]);
  }
}

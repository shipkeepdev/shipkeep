import { Inject, Injectable } from '@nestjs/common';
import {
  canChangeMembership,
  ConflictError,
  createEvent,
  isTenantId,
  NotFoundError,
  parseOrganizationRole,
  type OrganizationRole,
  type Secret,
} from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  AccountMutationAuthority,
  type AccountSubject,
  type PrivilegeChangeResult,
} from '../../identity/application/account-mutation-authority';
import type { SecurityContext } from '../../identity/application/mfa-commands';
import type { MfaProofInput } from '../../identity/application/mfa-crypto';

import { MEMBERSHIP_STORE, type MembershipRecord, type MembershipStore } from './membership-store';
import { TenantAccess } from './tenant-access';

@Injectable()
export class MembershipCommands {
  constructor(
    @Inject(MEMBERSHIP_STORE) private readonly store: MembershipStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  async add(
    context: SecurityContext,
    organizationId: string,
    email: string,
    inputRole: unknown,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<MembershipRecord>> {
    const role = parseOrganizationRole(inputRole);
    // Read-only preliminary checks: never acquire an actor lock before the ordered pair.
    await this.access.require(context.userId, 'member.manage', { organizationId });
    const candidate = await this.accounts.findVerifiedAccount(email);
    if (!candidate) throw new NotFoundError('resource');
    return this.accounts.changePrivileges(
      context,
      candidate.userId,
      password,
      factor,
      (subject) =>
        this.locked(context, organizationId, async () => {
          if (!subject.active || subject.email !== candidate.email)
            throw new NotFoundError('resource');
          const current = await this.store.forUser(organizationId, subject.userId);
          if (current && current.orgRole !== role)
            throw new ConflictError(
              'membership_exists',
              'Change the existing membership role instead.',
            );
          await this.authorize(context, organizationId, current?.orgRole ?? 'member', role);
          if (current) return { value: current, changed: false };
          const member = {
            id: uuidv7(),
            organizationId,
            userId: subject.userId,
            orgRole: role,
            createdAt: now,
            updatedAt: now,
          };
          await this.store.insert(member);
          await this.audit('added', context, member, now);
          return { value: member, changed: true };
        }),
      now,
    );
  }

  async setRole(
    context: SecurityContext,
    organizationId: string,
    membershipId: string,
    inputRole: unknown,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<MembershipRecord>> {
    const role = parseOrganizationRole(inputRole);
    return this.change(
      context,
      organizationId,
      membershipId,
      password,
      factor,
      async (current, subject) => {
        if (!current || !subject.active) throw new NotFoundError('resource');
        await this.authorize(context, organizationId, current.orgRole, role);
        if (current.orgRole === role) return { value: current, changed: false };
        const member = await this.store.setRole(organizationId, membershipId, role, now);
        await this.audit('role_changed', context, member, now, current.orgRole);
        return { value: member, changed: true };
      },
      now,
    );
  }

  remove(
    context: SecurityContext,
    organizationId: string,
    membershipId: string,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<null>> {
    return this.change(
      context,
      organizationId,
      membershipId,
      password,
      factor,
      async (current) => {
        if (!current) return { value: null, changed: false };
        await this.authorize(context, organizationId, current.orgRole, undefined);
        await this.store.remove(organizationId, membershipId);
        await this.audit('removed', context, current, now);
        return { value: null, changed: true };
      },
      now,
    );
  }

  private async change<T>(
    context: SecurityContext,
    organizationId: string,
    membershipId: string,
    password: Secret,
    factor: MfaProofInput,
    operation: (
      current: MembershipRecord | null,
      subject: AccountSubject,
    ) => Promise<{ value: T; changed: boolean }>,
    now: Date,
  ): Promise<PrivilegeChangeResult<T>> {
    if (!isTenantId(membershipId)) throw new NotFoundError('resource');
    await this.access.require(context.userId, 'member.manage', { organizationId });
    const initial = await this.store.transaction(organizationId, () =>
      this.store.find(organizationId, membershipId),
    );
    if (!initial) throw new NotFoundError('resource');
    return this.accounts.changePrivileges(
      context,
      initial.userId,
      password,
      factor,
      (subject) =>
        this.locked(context, organizationId, async () => {
          const current = await this.store.find(organizationId, membershipId);
          if (current && current.userId !== subject.userId) throw new NotFoundError('resource');
          return operation(current, subject);
        }),
      now,
    );
  }
  private locked<T>(
    context: SecurityContext,
    organizationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.store.transaction(organizationId, async () => {
      await this.store.lockOrganization(organizationId);
      await this.access.require(context.userId, 'member.manage', { organizationId });
      return operation();
    });
  }
  private async authorize(
    context: SecurityContext,
    organizationId: string,
    current: OrganizationRole,
    next: OrganizationRole | undefined,
  ): Promise<void> {
    const actor = await this.store.forUser(organizationId, context.userId);
    const owners = await this.store.ownerCount(organizationId);
    if (canChangeMembership(actor?.orgRole ?? '', current, next, owners)) return;
    if (actor?.orgRole === 'owner' && current === 'owner' && next !== 'owner' && owners === 1)
      throw new ConflictError(
        'last_organization_owner',
        'Add another owner before removing this ownership.',
      );
    throw new NotFoundError('resource');
  }
  private audit(
    action: string,
    context: SecurityContext,
    member: MembershipRecord,
    now: Date,
    previousRole?: OrganizationRole,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `membership.${action}`,
        organizationId: member.organizationId,
        occurredAt: now,
        actor: { kind: 'user', id: context.userId, ip: context.ip },
        target: { type: 'membership', id: member.id },
        payload: {
          userId: member.userId,
          role: member.orgRole,
          ...(previousRole ? { previousRole } : {}),
          ...(action === 'removed' ? { resourceBindingsRevoked: true } : {}),
        },
      }),
    ]);
  }
}

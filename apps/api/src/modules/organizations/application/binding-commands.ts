import { Inject, Injectable } from '@nestjs/common';
import {
  createEvent,
  isTenantId,
  NotFoundError,
  parseResourceRole,
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
import { normalizeEmail } from '../../identity/domain/identity-policy';

import {
  BINDING_STORE,
  type BindingRecord,
  type BindingStore,
  type BindingTarget,
} from './binding-store';
import { MEMBERSHIP_STORE, type MembershipRecord, type MembershipStore } from './membership-store';
import { TenantAccess } from './tenant-access';

@Injectable()
export class BindingCommands {
  constructor(
    @Inject(BINDING_STORE) private readonly bindings: BindingStore,
    @Inject(MEMBERSHIP_STORE) private readonly members: MembershipStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  async assign(
    context: SecurityContext,
    target: BindingTarget,
    email: string,
    inputRole: unknown,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<BindingRecord>> {
    const role = parseResourceRole(inputRole);
    const normalized = normalizeEmail(email);
    await this.requireScope(context, target);
    // Scope administrators resolve only exact existing organization members, not a global directory.
    const candidate = await this.members.transaction(target.organizationId, () =>
      this.members.forEmail(target.organizationId, normalized),
    );
    if (!candidate) throw new NotFoundError('resource');
    return this.change(
      context,
      target,
      candidate.id,
      password,
      factor,
      async (member, subject) => {
        if (member.orgRole !== 'member' || !subject.active || subject.email !== candidate.email)
          throw new NotFoundError('resource');
        const previous = await this.bindings.find(target, member.id);
        if (previous?.role === role) return { value: previous, changed: false };
        const binding: BindingRecord = {
          id: previous?.id ?? uuidv7(),
          organizationId: target.organizationId,
          projectId: target.projectId,
          environmentId: target.environmentId ?? null,
          membershipId: member.id,
          role,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        await this.bindings.save(binding);
        await this.audit('assigned', context, binding, subject.userId, now, previous?.role);
        return { value: binding, changed: true };
      },
      now,
    );
  }

  remove(
    context: SecurityContext,
    target: BindingTarget,
    membershipId: string,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<null>> {
    return this.change(
      context,
      target,
      membershipId,
      password,
      factor,
      async (member, subject) => {
        const current = await this.bindings.find(target, member.id);
        if (!current) return { value: null, changed: false };
        await this.bindings.remove(target, current.id);
        await this.audit('removed', context, current, subject.userId, now);
        return { value: null, changed: true };
      },
      now,
    );
  }
  private async change<T>(
    context: SecurityContext,
    target: BindingTarget,
    membershipId: string,
    password: Secret,
    factor: MfaProofInput,
    operation: (
      member: MembershipRecord,
      subject: AccountSubject,
    ) => Promise<{ value: T; changed: boolean }>,
    now: Date,
  ): Promise<PrivilegeChangeResult<T>> {
    if (!isTenantId(membershipId)) throw new NotFoundError('resource');
    await this.requireScope(context, target);
    const initial = await this.members.transaction(target.organizationId, () =>
      this.members.find(target.organizationId, membershipId),
    );
    if (!initial) throw new NotFoundError('resource');
    return this.accounts.changePrivileges(
      context,
      initial.userId,
      password,
      factor,
      (subject) =>
        this.members.transaction(target.organizationId, async () => {
          await this.members.lockOrganization(target.organizationId);
          await this.requireScope(context, target);
          const member = await this.members.find(target.organizationId, membershipId);
          if (!member || member.userId !== subject.userId) throw new NotFoundError('resource');
          return operation(member, subject);
        }),
      now,
    );
  }
  private async requireScope(context: SecurityContext, target: BindingTarget): Promise<void> {
    if (!isTenantId(target.projectId)) throw new NotFoundError('resource');
    await this.access.require(context.userId, 'member.manage', target);
  }
  private audit(
    action: string,
    context: SecurityContext,
    binding: BindingRecord,
    userId: string,
    now: Date,
    previousRole?: string,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `role_binding.${action}`,
        organizationId: binding.organizationId,
        occurredAt: now,
        actor: { kind: 'user', id: context.userId, ip: context.ip },
        target: { type: 'role_binding', id: binding.id },
        payload: {
          membershipId: binding.membershipId,
          userId,
          projectId: binding.projectId,
          environmentId: binding.environmentId,
          role: binding.role,
          ...(previousRole ? { previousRole } : {}),
        },
      }),
    ]);
  }
}

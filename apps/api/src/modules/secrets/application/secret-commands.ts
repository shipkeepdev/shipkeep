import { Inject, Injectable } from '@nestjs/common';
import { createEvent, NotFoundError, type Permission, type Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  assertSecretName,
  assertSecretValue,
  type SecretMetadata,
  type SecretTarget,
} from '../domain/secret-policy';

import {
  SECRET_STORE,
  SECRET_TRANSACTION,
  type SecretStore,
  type SecretTransaction,
} from './ports';

/**
 * Write-only environment secrets (SPEC 9, PLAN M3.7). Setting or removing needs `secret.write`
 * (developers only on unprotected environments, SPEC 7); listing names needs `environment.read`.
 * No method ever returns a value.
 */
@Injectable()
export class SecretCommands {
  constructor(
    @Inject(SECRET_STORE) private readonly store: SecretStore,
    @Inject(SECRET_TRANSACTION) private readonly transaction: SecretTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  set(
    context: SecurityContext,
    target: SecretTarget,
    name: string,
    value: Secret,
    now = new Date(),
  ): Promise<SecretMetadata> {
    assertSecretName(name);
    assertSecretValue(value);
    return this.scoped(context, 'secret.write', target, async () => {
      const metadata = await this.store.put(target, name, value, context.userId, now);
      await this.audit('set', context, target, metadata, now);
      return metadata;
    });
  }

  remove(
    context: SecurityContext,
    target: SecretTarget,
    name: string,
    now = new Date(),
  ): Promise<void> {
    assertSecretName(name);
    return this.scoped(context, 'secret.write', target, async () => {
      const removed = await this.store.remove(target, name);
      if (!removed) throw new NotFoundError('secret');
      await this.audit('removed', context, target, removed, now);
    });
  }

  list(context: SecurityContext, target: SecretTarget): Promise<SecretMetadata[]> {
    return this.scoped(context, 'environment.read', target, () => this.store.list(target));
  }

  private scoped<T>(
    context: SecurityContext,
    permission: Exclude<Permission, 'profile.read'>,
    target: SecretTarget,
    work: () => Promise<T>,
  ): Promise<T> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, permission, scope);
        return this.transaction.runTenant(target.organizationId, work);
      },
      { permission, target: scope },
    );
  }

  private audit(
    action: 'set' | 'removed',
    context: SecurityContext,
    target: SecretTarget,
    metadata: SecretMetadata,
    now: Date,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `secret.${action}`,
        organizationId: target.organizationId,
        actor: resourceActor(context),
        target: { type: 'secret', id: `${target.environmentId}/${metadata.name}` },
        // Names and versions only: the value never reaches the audit log.
        payload: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          name: metadata.name,
          version: metadata.version,
        },
        occurredAt: now,
      }),
    ]);
  }
}

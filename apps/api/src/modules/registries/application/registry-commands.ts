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
  assertRegistryPassword,
  assertRegistryUsername,
  type RegistryCredentialMetadata,
  registryServer,
} from '../domain/registry-credential';

import {
  REGISTRY_CREDENTIAL_STORE,
  REGISTRY_TRANSACTION,
  type RegistryCredentialStore,
  type RegistryTransaction,
} from './ports';

/** Who administers the organization manages its registry credentials (ADR 0019). */
const PERMISSION: Exclude<Permission, 'profile.read'> = 'organization.update';

/**
 * Registry credentials of an organization (ADR 0019): the user name and the password or token its
 * deployments use to pull private images from one registry. Write-only: no method returns a
 * password, and the audit log records the registry and the user name, never the password.
 */
@Injectable()
export class RegistryCommands {
  constructor(
    @Inject(REGISTRY_CREDENTIAL_STORE) private readonly store: RegistryCredentialStore,
    @Inject(REGISTRY_TRANSACTION) private readonly transaction: RegistryTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  set(
    context: SecurityContext,
    organizationId: string,
    input: { server: string; username: string; password: Secret },
    now = new Date(),
  ): Promise<RegistryCredentialMetadata> {
    const server = registryServer(input.server);
    assertRegistryUsername(input.username);
    assertRegistryPassword(input.password);
    return this.scoped(context, organizationId, async () => {
      const metadata = await this.store.put(
        organizationId,
        { server, username: input.username, password: input.password },
        context.userId,
        now,
      );
      await this.audit('set', context, organizationId, metadata, now);
      return metadata;
    });
  }

  remove(
    context: SecurityContext,
    organizationId: string,
    id: string,
    now = new Date(),
  ): Promise<void> {
    return this.scoped(context, organizationId, async () => {
      const removed = await this.store.remove(organizationId, id);
      if (!removed) throw new NotFoundError('resource');
      await this.audit('removed', context, organizationId, removed, now);
    });
  }

  list(context: SecurityContext, organizationId: string): Promise<RegistryCredentialMetadata[]> {
    return this.scoped(context, organizationId, () => this.store.list(organizationId));
  }

  private scoped<T>(
    context: SecurityContext,
    organizationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const scope = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, PERMISSION, scope);
        return this.transaction.runTenant(organizationId, work);
      },
      { permission: PERMISSION, target: scope },
    );
  }

  private audit(
    action: 'set' | 'removed',
    context: SecurityContext,
    organizationId: string,
    metadata: RegistryCredentialMetadata,
    now: Date,
  ): Promise<void> {
    return this.events.publish([
      createEvent({
        type: `registry.credentials_${action}`,
        organizationId,
        actor: resourceActor(context),
        target: { type: 'registry', id: metadata.id },
        // The registry, the user name and the version: the password never reaches the audit log.
        payload: {
          server: metadata.server,
          username: metadata.username,
          version: metadata.version,
        },
        occurredAt: now,
      }),
    ]);
  }
}

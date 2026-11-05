import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, type Permission, type ResourceContext } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';

import {
  CATALOG_STORE,
  type CatalogBounds,
  type CatalogPage,
  type CatalogStore,
} from './catalog-store';
import type { OrganizationRecord } from './organization-store';
import type {
  EnvironmentRecord,
  EnvironmentTarget,
  ProjectRecord,
  ProjectTarget,
} from './resource-store';
import { TenantAccess } from './tenant-access';
import { page, pagination } from './catalog-page';

@Injectable()
export class CatalogQueries {
  constructor(
    @Inject(CATALOG_STORE) private readonly store: CatalogStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
  ) {}
  async organizations(
    context: SecurityContext,
    input: Partial<CatalogBounds> = {},
  ): Promise<CatalogPage<OrganizationRecord>> {
    const bounds = pagination(input);
    return this.accounts.run(context, () =>
      this.store.account(context.userId, async () =>
        page(await this.store.organizations(context.userId, bounds), bounds),
      ),
    );
  }
  async projects(
    context: SecurityContext,
    organizationId: string,
    input: Partial<CatalogBounds> = {},
  ): Promise<CatalogPage<ProjectRecord>> {
    const bounds = pagination(input);
    return this.read(context, { organizationId }, 'organization.read', async () =>
      page(await this.store.projects(context.userId, organizationId, bounds), bounds),
    );
  }
  async environments(
    context: SecurityContext,
    target: ProjectTarget,
    input: Partial<CatalogBounds> = {},
  ): Promise<CatalogPage<EnvironmentRecord>> {
    const bounds = pagination(input);
    return this.read(context, target, 'project.read', async () =>
      page(await this.store.environments(context.userId, target, bounds), bounds),
    );
  }
  organization(context: SecurityContext, organizationId: string): Promise<OrganizationRecord> {
    return this.read(
      context,
      { organizationId },
      'organization.read',
      async () => required(await this.store.organization(organizationId)),
      true,
    );
  }
  project(context: SecurityContext, target: ProjectTarget): Promise<ProjectRecord> {
    return this.read(
      context,
      target,
      'project.read',
      async () => required(await this.store.project(target)),
      true,
    );
  }
  environment(context: SecurityContext, target: EnvironmentTarget): Promise<EnvironmentRecord> {
    return this.read(
      context,
      target,
      'environment.read',
      async () => required(await this.store.environment(target)),
      true,
    );
  }
  private read<T>(
    context: SecurityContext,
    target: ResourceContext & { organizationId: string },
    permission: Permission,
    operation: () => Promise<T>,
    allowApiToken = false,
  ): Promise<T> {
    return this.accounts.run(
      context,
      () =>
        this.store.tenant(target.organizationId, async () => {
          await this.access.require(context.userId, permission, target);
          return operation();
        }),
      // Collections need per-item scope filtering before pagination; they remain session-only.
      allowApiToken ? { permission, target } : undefined,
    );
  }
}
function required<T>(value: T | null): T {
  if (value === null) throw new NotFoundError('resource');
  return value;
}

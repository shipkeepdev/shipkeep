import { Inject, Injectable } from '@nestjs/common';
import { isTenantId, NotFoundError, type ResourceContext } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { SecurityContext } from '../../identity/application/mfa-commands';

import {
  ADMINISTRATION_STORE,
  type AdministrationStore,
  type BindingView,
  type MemberView,
} from './administration-store';
import type { BindingTarget } from './binding-store';
import { page, pagination } from './catalog-page';
import type { CatalogBounds, CatalogPage } from './catalog-store';
import { TenantAccess } from './tenant-access';

@Injectable()
export class AdministrationQueries {
  constructor(
    @Inject(ADMINISTRATION_STORE) private readonly store: AdministrationStore,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
  ) {}
  async members(
    context: SecurityContext,
    organizationId: string,
    input: Partial<CatalogBounds> = {},
  ): Promise<CatalogPage<MemberView>> {
    const bounds = pagination(input);
    return this.read(context, { organizationId }, async () =>
      page(await this.store.members(organizationId, bounds), bounds),
    );
  }
  async bindings(
    context: SecurityContext,
    target: BindingTarget,
    input: Partial<CatalogBounds> = {},
  ): Promise<CatalogPage<BindingView>> {
    const bounds = pagination(input);
    if (!isTenantId(target.projectId)) throw new NotFoundError('resource');
    return this.read(context, target, async () =>
      page(await this.store.bindings(target, bounds), bounds),
    );
  }
  private read<T>(
    context: SecurityContext,
    target: ResourceContext & { organizationId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.accounts.run(context, () =>
      this.store.transaction(target.organizationId, async () => {
        await this.access.require(context.userId, 'member.manage', target);
        return operation();
      }),
    );
  }
}

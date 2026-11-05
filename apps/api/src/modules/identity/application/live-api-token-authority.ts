import { Injectable } from '@nestjs/common';
import type { Permission, ResourceContext } from '@shipkeep/domain';

import { TenantAccess } from '../../organizations/application/tenant-access';

import { AccountTokenAuthority, type ApiTokenAuthority } from './api-token-authority';

@Injectable()
export class LiveApiTokenAuthority implements ApiTokenAuthority {
  private readonly account = new AccountTokenAuthority();

  constructor(private readonly tenants: TenantAccess) {}

  allows(
    userId: string,
    permission: Permission,
    target: ResourceContext,
  ): boolean | Promise<boolean> {
    return permission === 'profile.read'
      ? this.account.allows(userId, permission, target)
      : this.tenants.allows(userId, permission, target);
  }
}

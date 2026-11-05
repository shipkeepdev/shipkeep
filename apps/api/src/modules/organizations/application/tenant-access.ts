import { Inject, Injectable } from '@nestjs/common';
import {
  allowsTenantAction,
  isTenantId,
  NotFoundError,
  PERMISSIONS,
  type ResourceContext,
} from '@shipkeep/domain';

import { TENANT_ACCESS_STORE, type TenantAccessStore } from './tenant-access-store';

const permissions: ReadonlySet<string> = new Set(PERMISSIONS);

/** Live authorization for sessions and API tokens; never accepts role/protection metadata. */
@Injectable()
export class TenantAccess {
  constructor(@Inject(TENANT_ACCESS_STORE) private readonly store: TenantAccessStore) {}

  async allows(userId: string, permission: string, target: ResourceContext): Promise<boolean> {
    const organizationId = target.organizationId;
    if (
      !isTenantId(userId) ||
      !isTenantId(organizationId) ||
      !permissions.has(permission) ||
      permission === 'profile.read' ||
      (target.projectId !== undefined && !isTenantId(target.projectId)) ||
      (target.environmentId !== undefined &&
        (!isTenantId(target.environmentId) || !target.projectId))
    )
      return false;
    return this.store.transaction(organizationId, async () => {
      const current = await this.store.resolve(userId, organizationId, target);
      return (
        current !== undefined &&
        allowsTenantAction(current.membership, permission, current.resource)
      );
    });
  }

  async require(userId: string, permission: string, target: ResourceContext): Promise<void> {
    // One response for missing resources and unavailable permissions; no cross-tenant existence leak.
    if (!(await this.allows(userId, permission, target))) throw new NotFoundError('resource');
  }
}

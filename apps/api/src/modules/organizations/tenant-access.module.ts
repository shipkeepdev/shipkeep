import { Module } from '@nestjs/common';

import { TenantAccess } from './application/tenant-access';
import { TENANT_ACCESS_STORE } from './application/tenant-access-store';
import { PrismaTenantAccessStore } from './infrastructure/prisma-tenant-access.store';

/** Read-side module independent of identity commands, avoiding a token/RBAC dependency cycle. */
@Module({
  providers: [TenantAccess, { provide: TENANT_ACCESS_STORE, useClass: PrismaTenantAccessStore }],
  exports: [TenantAccess],
})
export class TenantAccessModule {}

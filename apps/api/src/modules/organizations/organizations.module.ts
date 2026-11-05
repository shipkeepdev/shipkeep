import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';

import { OrganizationCommands } from './application/organization-commands';
import { ORGANIZATION_STORE } from './application/organization-store';
import { PrismaOrganizationStore } from './infrastructure/prisma-organization.store';
import { TenantAccessModule } from './tenant-access.module';

@Module({
  imports: [IdentityModule, TenantAccessModule],
  providers: [
    OrganizationCommands,
    { provide: ORGANIZATION_STORE, useClass: PrismaOrganizationStore },
  ],
})
export class OrganizationsModule {}

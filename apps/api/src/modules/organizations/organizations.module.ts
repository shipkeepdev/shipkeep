import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';

import { OrganizationCommands } from './application/organization-commands';
import { ORGANIZATION_STORE } from './application/organization-store';
import { PrismaOrganizationStore } from './infrastructure/prisma-organization.store';
import { ResourceCommands } from './application/resource-commands';
import { RESOURCE_STORE } from './application/resource-store';
import { PrismaResourceStore } from './infrastructure/prisma-resource.store';
import { CatalogQueries } from './application/catalog-queries';
import { CATALOG_STORE } from './application/catalog-store';
import { PrismaCatalogStore } from './infrastructure/prisma-catalog.store';
import { MembershipCommands } from './application/membership-commands';
import { MEMBERSHIP_STORE } from './application/membership-store';
import { PrismaMembershipStore } from './infrastructure/prisma-membership.store';
import { BindingCommands } from './application/binding-commands';
import { BINDING_STORE } from './application/binding-store';
import { PrismaBindingStore } from './infrastructure/prisma-binding.store';
import { AdministrationQueries } from './application/administration-queries';
import { ADMINISTRATION_STORE } from './application/administration-store';
import { PrismaAdministrationStore } from './infrastructure/prisma-administration.store';
import { TenantAccessModule } from './tenant-access.module';
import { CatalogController } from './interface/catalog.controller';
import { OrganizationMutationController } from './interface/organization-mutation.controller';
import { ResourceMutationController } from './interface/resource-mutation.controller';

import { AdministrationController } from './interface/administration.controller';
import { MembershipMutationController } from './interface/membership-mutation.controller';
import { BindingMutationController } from './interface/binding-mutation.controller';

@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [
    CatalogController,
    OrganizationMutationController,
    ResourceMutationController,
    AdministrationController,
    MembershipMutationController,
    BindingMutationController,
  ],
  providers: [
    OrganizationCommands,
    ResourceCommands,
    CatalogQueries,
    MembershipCommands,
    BindingCommands,
    AdministrationQueries,
    { provide: ADMINISTRATION_STORE, useClass: PrismaAdministrationStore },
    { provide: BINDING_STORE, useClass: PrismaBindingStore },
    { provide: MEMBERSHIP_STORE, useClass: PrismaMembershipStore },
    { provide: CATALOG_STORE, useClass: PrismaCatalogStore },
    { provide: RESOURCE_STORE, useClass: PrismaResourceStore },
    { provide: ORGANIZATION_STORE, useClass: PrismaOrganizationStore },
  ],
})
export class OrganizationsModule {}

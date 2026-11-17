import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { REGISTRY_CREDENTIAL_STORE, REGISTRY_TRANSACTION } from './application/ports';
import { RegistryCommands } from './application/registry-commands';
import { PrismaRegistryCredentialStore } from './infrastructure/prisma-registry-credential.store';
import { RegistryController } from './interface/registry.controller';

/** Registry credentials of an organization (ADR 0019). The store is exported for deployments. */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [RegistryController],
  providers: [
    RegistryCommands,
    { provide: REGISTRY_CREDENTIAL_STORE, useClass: PrismaRegistryCredentialStore },
    { provide: REGISTRY_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  exports: [REGISTRY_CREDENTIAL_STORE],
})
export class RegistriesModule {}

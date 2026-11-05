import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { SECRET_STORE, SECRET_TRANSACTION } from './application/ports';
import { SecretCommands } from './application/secret-commands';
import { PrismaSecretStore } from './infrastructure/prisma-secret.store';
import { SecretController } from './interface/secret.controller';

/** Environment secrets (SPEC 9, PLAN M3.7). The store is exported for deployments. */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [SecretController],
  providers: [
    SecretCommands,
    { provide: SECRET_STORE, useClass: PrismaSecretStore },
    { provide: SECRET_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  exports: [SECRET_STORE],
})
export class SecretsModule {}

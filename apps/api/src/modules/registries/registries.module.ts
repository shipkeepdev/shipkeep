import { Module } from '@nestjs/common';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { InstallationKeysModule } from '../fleet/installation-keys.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import {
  REGISTRY_CREDENTIAL_STORE,
  REGISTRY_GRANT_STORE,
  REGISTRY_JWKS_FILE,
  REGISTRY_SERVICE,
  REGISTRY_TRANSACTION,
} from './application/ports';
import { RegistryCommands } from './application/registry-commands';
import { RegistryGrants } from './application/registry-grants';
import { RegistryTokens } from './application/registry-tokens';
import { PrismaRegistryCredentialStore } from './infrastructure/prisma-registry-credential.store';
import { PrismaRegistryGrantStore } from './infrastructure/prisma-registry-grant.store';
import { RegistryJwks } from './infrastructure/registry-jwks.file';
import { RegistryTokenController } from './interface/registry-token.controller';
import { RegistryController } from './interface/registry.controller';

/**
 * Registry credentials of an organization (ADR 0019), exported for deployments, and the token
 * endpoint of the installation's own registry with the grants it checks (ADR 0030).
 */
@Module({
  imports: [IdentityModule, TenantAccessModule, InstallationKeysModule],
  controllers: [RegistryController, RegistryTokenController],
  providers: [
    RegistryCommands,
    RegistryGrants,
    RegistryTokens,
    RegistryJwks,
    { provide: REGISTRY_CREDENTIAL_STORE, useClass: PrismaRegistryCredentialStore },
    { provide: REGISTRY_GRANT_STORE, useClass: PrismaRegistryGrantStore },
    { provide: REGISTRY_TRANSACTION, useExisting: PrismaUnitOfWork },
    {
      provide: REGISTRY_SERVICE,
      useFactory: (config: AppConfig) => new URL(config.get('API_PUBLIC_URL')).host,
      inject: [AppConfig],
    },
    {
      provide: REGISTRY_JWKS_FILE,
      useFactory: (config: AppConfig) => config.get('REGISTRY_JWKS_FILE'),
      inject: [AppConfig],
    },
  ],
  exports: [REGISTRY_CREDENTIAL_STORE, RegistryGrants],
})
export class RegistriesModule {}

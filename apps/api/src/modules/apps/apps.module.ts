import { Module } from '@nestjs/common';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { ConfirmationsModule } from '../confirmations/confirmations.module';
import { FleetModule } from '../fleet/fleet.module';
import { GitModule } from '../git/git.module';
import { IdentityModule } from '../identity/identity.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { ApplicationCommands } from './application/application-commands';
import { ApplicationConfirmationTarget } from './application/application-confirmation-target';
import { DomainCertificates } from './application/domain-certificates';
import { EnvironmentClone } from './application/environment-clone';
import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  CONTROL_PLANE_HOST,
  DOMAIN_CERTIFICATE_STORE,
  DOMAIN_RESOLVER,
} from './application/ports';
import { DnsDomainResolver } from './infrastructure/dns-domain.resolver';
import { PrismaApplicationStore } from './infrastructure/prisma-application.store';
import { PrismaDomainCertificateStore } from './infrastructure/prisma-domain-certificate.store';
import { ApplicationController } from './interface/application.controller';

/** Applications (SPEC 4, PLAN M3.4b). The store is exported for the deployments context. */
@Module({
  imports: [
    IdentityModule,
    TenantAccessModule,
    ConfirmationsModule,
    FleetModule,
    OrganizationsModule,
    // A Git application's configuration is read from its repository.
    GitModule,
  ],
  controllers: [ApplicationController],
  providers: [
    ApplicationCommands,
    EnvironmentClone,
    ApplicationConfirmationTarget,
    DomainCertificates,
    { provide: APPLICATION_STORE, useClass: PrismaApplicationStore },
    { provide: DOMAIN_CERTIFICATE_STORE, useClass: PrismaDomainCertificateStore },
    { provide: APPLICATION_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: DOMAIN_RESOLVER, useClass: DnsDomainResolver },
    {
      provide: CONTROL_PLANE_HOST,
      useFactory: (config: AppConfig) => new URL(config.get('API_PUBLIC_URL')).hostname,
      inject: [AppConfig],
    },
  ],
  // ApplicationCommands applies a pushed configuration for the deployments context.
  exports: [APPLICATION_STORE, CONTROL_PLANE_HOST, ApplicationCommands],
})
export class AppsModule {}

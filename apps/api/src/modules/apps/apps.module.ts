import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { ApplicationCommands } from './application/application-commands';
import { APPLICATION_STORE, APPLICATION_TRANSACTION } from './application/ports';
import { PrismaApplicationStore } from './infrastructure/prisma-application.store';
import { ApplicationController } from './interface/application.controller';

/** Applications (SPEC 4, PLAN M3.4b). The store is exported for the deployments context. */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [ApplicationController],
  providers: [
    ApplicationCommands,
    { provide: APPLICATION_STORE, useClass: PrismaApplicationStore },
    { provide: APPLICATION_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  exports: [APPLICATION_STORE],
})
export class AppsModule {}

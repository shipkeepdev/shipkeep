import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { AppsModule } from '../apps/apps.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';
import { SecretsModule } from '../secrets/secrets.module';

import { DeploymentCommands } from './application/deployment-commands';
import { DEPLOYMENT_STORE, DEPLOYMENT_TRANSACTION } from './application/ports';
import { PrismaDeploymentStore } from './infrastructure/prisma-deployment.store';
import { DeploymentController } from './interface/deployment.controller';

/** Releases and deployments (SPEC 4, 5.1; PLAN M3.4b2). Orchestration arrives with M3.4c. */
@Module({
  imports: [IdentityModule, TenantAccessModule, AppsModule, SecretsModule],
  controllers: [DeploymentController],
  providers: [
    DeploymentCommands,
    { provide: DEPLOYMENT_STORE, useClass: PrismaDeploymentStore },
    { provide: DEPLOYMENT_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  exports: [DEPLOYMENT_STORE],
})
export class DeploymentsModule {}

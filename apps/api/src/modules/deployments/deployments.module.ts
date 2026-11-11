import { Module } from '@nestjs/common';

import { JobsModule } from '../../platform/jobs/jobs.module';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { AgentActions } from '../fleet/application/agent-actions';
import { FleetModule } from '../fleet/fleet.module';
import { AppsModule } from '../apps/apps.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';
import { SecretsModule } from '../secrets/secrets.module';

import { AllocationObservations } from './application/allocation-observations';
import { DeploymentCommands } from './application/deployment-commands';
import { DeploymentPipeline } from './application/deployment-pipeline';
import {
  ACTION_HISTORY,
  ACTION_QUEUE,
  DEPLOYMENT_STORE,
  DEPLOYMENT_TRANSACTION,
  DEPLOYMENT_WAKER,
  IMAGE_RESOLVER,
  OBSERVATION_STORE,
  PIPELINE_STORE,
} from './application/ports';
import { DeploymentQueue } from './infrastructure/deployment-queue';
import { DeploymentWorker } from './infrastructure/deployment-worker';
import { PrismaDeploymentStore } from './infrastructure/prisma-deployment.store';
import { PrismaObservationStore } from './infrastructure/prisma-observation.store';
import { PrismaPipelineStore } from './infrastructure/prisma-pipeline.store';
import { RegistryResolver } from './infrastructure/registry/registry-resolver';
import { DeploymentController } from './interface/deployment.controller';

/** Releases, deployments and their pipeline (SPEC 4, 5.1; PLAN M3.4b2, M3.4c). */
@Module({
  imports: [IdentityModule, TenantAccessModule, AppsModule, SecretsModule, FleetModule, JobsModule],
  controllers: [DeploymentController],
  providers: [
    DeploymentCommands,
    { provide: DEPLOYMENT_STORE, useClass: PrismaDeploymentStore },
    { provide: DEPLOYMENT_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: IMAGE_RESOLVER, useFactory: () => new RegistryResolver() },
    { provide: PIPELINE_STORE, useClass: PrismaPipelineStore },
    { provide: ACTION_QUEUE, useExisting: AgentActions },
    { provide: ACTION_HISTORY, useExisting: AgentActions },
    DeploymentQueue,
    { provide: DEPLOYMENT_WAKER, useExisting: DeploymentQueue },
    DeploymentPipeline,
    { provide: OBSERVATION_STORE, useClass: PrismaObservationStore },
    AllocationObservations,
    DeploymentWorker,
  ],
  exports: [DEPLOYMENT_STORE, IMAGE_RESOLVER, DeploymentWorker],
})
export class DeploymentsModule {}

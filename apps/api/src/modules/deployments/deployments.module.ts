import { Module } from '@nestjs/common';

import { JobsModule } from '../../platform/jobs/jobs.module';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { AgentActions } from '../fleet/application/agent-actions';
import { FleetModule } from '../fleet/fleet.module';
import { AppsModule } from '../apps/apps.module';
import { GitModule } from '../git/git.module';
import { ConfirmationsModule } from '../confirmations/confirmations.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';
import { RegistriesModule } from '../registries/registries.module';
import { SecretsModule } from '../secrets/secrets.module';

import { AllocationObservations } from './application/allocation-observations';
import { DeploymentCommands } from './application/deployment-commands';
import { PushDeployments } from './application/push-deployments';
import { DeploymentPipeline } from './application/deployment-pipeline';
import { ExecSessions } from './application/exec-sessions';
import {
  ACTION_HISTORY,
  BUILD_TOKENS,
  ACTION_QUEUE,
  DEPLOYMENT_STEPS,
  DEPLOYMENT_STORE,
  DEPLOYMENT_TRANSACTION,
  DEPLOYMENT_WAKER,
  IMAGE_RESOLVER,
  OBSERVATION_STORE,
  PIPELINE_STORE,
} from './application/ports';
import { DeploymentQueue } from './infrastructure/deployment-queue';
import { DeploymentWorker } from './infrastructure/deployment-worker';
import { PushWorker } from './infrastructure/push-worker';
import { PrismaDeploymentStore } from './infrastructure/prisma-deployment.store';
import { PrismaDeploymentSteps } from './infrastructure/prisma-deployment-steps.store';
import { PrismaObservationStore } from './infrastructure/prisma-observation.store';
import { PrismaPipelineStore } from './infrastructure/prisma-pipeline.store';
import { RegistryResolver } from './infrastructure/registry/registry-resolver';
import { DeploymentController } from './interface/deployment.controller';
import { ExecSessionController } from './interface/exec-session.controller';
import { ExecSocket } from './interface/exec-socket';
import { UntrackedContainers } from './application/untracked-containers';
import { NodeReplicasController } from './interface/node-replicas.controller';

/** Releases, deployments and their pipeline (SPEC 4, 5.1; PLAN M3.4b2, M3.4c). */
@Module({
  imports: [
    IdentityModule,
    TenantAccessModule,
    AppsModule,
    // A Git application's configuration is read again when a push deploys it.
    GitModule,
    SecretsModule,
    FleetModule,
    JobsModule,
    ConfirmationsModule,
    RegistriesModule,
  ],
  controllers: [DeploymentController, NodeReplicasController, ExecSessionController],
  providers: [
    DeploymentCommands,
    UntrackedContainers,
    ExecSessions,
    ExecSocket,
    { provide: DEPLOYMENT_STORE, useClass: PrismaDeploymentStore },
    { provide: DEPLOYMENT_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: IMAGE_RESOLVER, useFactory: () => new RegistryResolver() },
    { provide: PIPELINE_STORE, useClass: PrismaPipelineStore },
    { provide: ACTION_QUEUE, useExisting: AgentActions },
    { provide: ACTION_HISTORY, useExisting: AgentActions },
    { provide: BUILD_TOKENS, useExisting: AgentActions },
    { provide: DEPLOYMENT_STEPS, useClass: PrismaDeploymentSteps },
    DeploymentQueue,
    { provide: DEPLOYMENT_WAKER, useExisting: DeploymentQueue },
    DeploymentPipeline,
    { provide: OBSERVATION_STORE, useClass: PrismaObservationStore },
    AllocationObservations,
    DeploymentWorker,
    PushDeployments,
    PushWorker,
  ],
  exports: [DEPLOYMENT_STORE, IMAGE_RESOLVER, DeploymentWorker, PushWorker],
})
export class DeploymentsModule {}

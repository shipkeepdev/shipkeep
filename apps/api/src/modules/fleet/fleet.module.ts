import { Module } from '@nestjs/common';

import { API_VERSION } from '../../platform/health/health.controller';
import { JobsModule } from '../../platform/jobs/jobs.module';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { ConfirmationsModule } from '../confirmations/confirmations.module';

import { AuditModule } from '../audit/audit.module';

import { ExecSessionRegistry } from './application/exec-relay';
import { ExecSessionChecks } from './infrastructure/exec-session-checks';
import { FleetAdministration } from './application/fleet-administration';
import { NodeConfirmationTarget } from './application/node-confirmation-target';
import { FleetAdministrationController } from './interface/fleet-administration.controller';
import { InstallationKeysModule } from './installation-keys.module';
import { AuthenticateNode } from './application/authenticate-node';
import { NodeReadoptions } from './application/readopt-node';
import { RenewNodeCertificate } from './application/renew-node-certificate';
import { PrismaNodeCredentialStore } from './infrastructure/prisma-node-credential.store';
import { PrismaNodeReadoptionStore } from './infrastructure/prisma-node-readoption.store';
import { AppConfig } from '../../platform/config/app-config';
import { AgentGateway } from './interface/agent-gateway';
import { EnrollmentAdmission } from './interface/enrollment-admission';
import { LogStreams } from './interface/log-stream';
import { NodeStream } from './interface/node-stream';

import { EnrollNode } from './application/enroll-node';
import { IssueJoinToken } from './application/issue-join-token';
import {
  AGENT_UPGRADE_WAKER,
  AgentUpgrades,
  CONTROL_PLANE_VERSION,
} from './application/agent-upgrades';
import {
  AGENT_ACTION_STORE,
  AGENT_RELEASES,
  AGENT_UPGRADE_STORE,
  JOIN_TOKEN_STORE,
  NODE_STORE,
  NODE_CREDENTIAL_STORE,
  NODE_READOPTION_STORE,
  FLEET_TRANSACTION,
  EXEC_SESSION_CHECKS,
} from './application/ports';
import { PrismaJoinTokenStore, PrismaNodeStore } from './infrastructure/prisma-fleet.stores';
import { AgentUpgradeQueue } from './infrastructure/agent-upgrade-queue';
import { AgentUpgradeWorker } from './infrastructure/agent-upgrade-worker';
import { GithubAgentReleases } from './infrastructure/github-agent-releases';
import { PrismaAgentActionStore } from './infrastructure/prisma-agent-action.store';
import { PrismaAgentUpgradeStore } from './infrastructure/prisma-agent-upgrade.store';
import { AgentActions } from './application/agent-actions';
import { NodeLiveness } from './application/node-liveness';
import { LogBatches } from './application/log-batches';
import { MetricsReports } from './application/metrics-reports';
import { StateReports } from './application/state-reports';

/**
 * Fleet: nodes, enrollment, certificates (SPEC section 3.2). Agents use the gRPC gateway;
 * organization administrators use the session-only REST routes of M2.7.
 */
@Module({
  imports: [
    IdentityModule,
    TenantAccessModule,
    InstallationKeysModule,
    ConfirmationsModule,
    JobsModule,
    AuditModule,
  ],
  controllers: [FleetAdministrationController],
  providers: [
    FleetAdministration,
    NodeConfirmationTarget,
    AgentGateway,
    {
      provide: EnrollmentAdmission,
      useFactory: (config: AppConfig) => EnrollmentAdmission.fromConfig(config),
      inject: [AppConfig],
    },
    NodeStream,
    LogStreams,
    ExecSessionRegistry,
    ExecSessionChecks,
    { provide: EXEC_SESSION_CHECKS, useExisting: ExecSessionChecks },
    AuthenticateNode,
    RenewNodeCertificate,
    { provide: FLEET_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: NODE_CREDENTIAL_STORE, useClass: PrismaNodeCredentialStore },
    { provide: NODE_READOPTION_STORE, useClass: PrismaNodeReadoptionStore },
    NodeReadoptions,
    { provide: JOIN_TOKEN_STORE, useClass: PrismaJoinTokenStore },
    { provide: NODE_STORE, useClass: PrismaNodeStore },
    { provide: AGENT_ACTION_STORE, useClass: PrismaAgentActionStore },
    AgentActions,
    { provide: AGENT_UPGRADE_STORE, useClass: PrismaAgentUpgradeStore },
    { provide: AGENT_RELEASES, useFactory: () => new GithubAgentReleases() },
    { provide: CONTROL_PLANE_VERSION, useValue: API_VERSION },
    AgentUpgradeQueue,
    { provide: AGENT_UPGRADE_WAKER, useExisting: AgentUpgradeQueue },
    AgentUpgrades,
    AgentUpgradeWorker,
    NodeLiveness,
    StateReports,
    MetricsReports,
    LogBatches,
    IssueJoinToken,
    EnrollNode,
  ],
  exports: [
    AgentGateway,
    EnrollmentAdmission,
    IssueJoinToken,
    EnrollNode,
    InstallationKeysModule,
    AuthenticateNode,
    RenewNodeCertificate,
    AgentActions,
    AgentUpgradeWorker,
    StateReports,
    MetricsReports,
    LogBatches,
    ExecSessionRegistry,
    ExecSessionChecks,
    EXEC_SESSION_CHECKS,
  ],
})
export class FleetModule {}

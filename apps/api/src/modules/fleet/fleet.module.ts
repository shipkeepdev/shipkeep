import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { FleetAdministration } from './application/fleet-administration';
import { FleetAdministrationController } from './interface/fleet-administration.controller';
import { InstallationKeysModule } from './installation-keys.module';
import { AuthenticateNode } from './application/authenticate-node';
import { RenewNodeCertificate } from './application/renew-node-certificate';
import { PrismaNodeCredentialStore } from './infrastructure/prisma-node-credential.store';
import { AgentGateway } from './interface/agent-gateway';
import { NodeStream } from './interface/node-stream';

import { EnrollNode } from './application/enroll-node';
import { IssueJoinToken } from './application/issue-join-token';
import {
  JOIN_TOKEN_STORE,
  NODE_STORE,
  NODE_CREDENTIAL_STORE,
  FLEET_TRANSACTION,
} from './application/ports';
import { PrismaJoinTokenStore, PrismaNodeStore } from './infrastructure/prisma-fleet.stores';

/**
 * Fleet: nodes, enrollment, certificates (SPEC section 3.2). Agents use the gRPC gateway;
 * organization administrators use the session-only REST routes of M2.7.
 */
@Module({
  imports: [IdentityModule, TenantAccessModule, InstallationKeysModule],
  controllers: [FleetAdministrationController],
  providers: [
    FleetAdministration,
    AgentGateway,
    NodeStream,
    AuthenticateNode,
    RenewNodeCertificate,
    { provide: FLEET_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: NODE_CREDENTIAL_STORE, useClass: PrismaNodeCredentialStore },
    { provide: JOIN_TOKEN_STORE, useClass: PrismaJoinTokenStore },
    { provide: NODE_STORE, useClass: PrismaNodeStore },
    IssueJoinToken,
    EnrollNode,
  ],
  exports: [
    AgentGateway,
    IssueJoinToken,
    EnrollNode,
    InstallationKeysModule,
    AuthenticateNode,
    RenewNodeCertificate,
  ],
})
export class FleetModule {}

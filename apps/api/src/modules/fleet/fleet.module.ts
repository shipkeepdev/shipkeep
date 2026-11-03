import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { AuthenticateNode } from './application/authenticate-node';
import { RenewNodeCertificate } from './application/renew-node-certificate';
import { PrismaNodeCredentialStore } from './infrastructure/prisma-node-credential.store';

import { EnrollNode } from './application/enroll-node';
import { IssueJoinToken } from './application/issue-join-token';
import {
  CERTIFICATE_AUTHORITY,
  CONFIRMATION_KEY_PROVIDER,
  JOIN_TOKEN_STORE,
  NODE_STORE,
  NODE_CREDENTIAL_STORE,
  FLEET_TRANSACTION,
} from './application/ports';
import { INSTALLATION_KEY_STORE } from './infrastructure/ca/installation-key-store';
import { X509CertificateAuthority } from './infrastructure/ca/x509-certificate-authority';
import {
  PrismaInstallationKeyStore,
  PrismaJoinTokenStore,
  PrismaNodeStore,
} from './infrastructure/prisma-fleet.stores';

/**
 * Fleet: nodes, enrollment, certificates (SPEC section 3.2). The REST interface for join tokens
 * arrives with RBAC (M2.3); the gRPC gateway that exposes Enroll to agents is task M1.2b.
 */
@Module({
  providers: [
    AuthenticateNode,
    RenewNodeCertificate,
    { provide: FLEET_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: NODE_CREDENTIAL_STORE, useClass: PrismaNodeCredentialStore },
    { provide: INSTALLATION_KEY_STORE, useClass: PrismaInstallationKeyStore },
    { provide: JOIN_TOKEN_STORE, useClass: PrismaJoinTokenStore },
    { provide: NODE_STORE, useClass: PrismaNodeStore },
    X509CertificateAuthority,
    { provide: CERTIFICATE_AUTHORITY, useExisting: X509CertificateAuthority },
    { provide: CONFIRMATION_KEY_PROVIDER, useExisting: X509CertificateAuthority },
    IssueJoinToken,
    EnrollNode,
  ],
  exports: [
    IssueJoinToken,
    EnrollNode,
    CERTIFICATE_AUTHORITY,
    AuthenticateNode,
    RenewNodeCertificate,
  ],
})
export class FleetModule {}

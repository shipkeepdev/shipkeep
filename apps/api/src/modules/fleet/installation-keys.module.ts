import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';

import {
  CERTIFICATE_AUTHORITY,
  CONFIRMATION_KEY_PROVIDER,
  FLEET_TRANSACTION,
  REGISTRY_TOKEN_KEY,
} from './application/ports';
import { INSTALLATION_KEY_STORE } from './infrastructure/ca/installation-key-store';
import { X509CertificateAuthority } from './infrastructure/ca/x509-certificate-authority';
import { PrismaInstallationKeyStore } from './infrastructure/prisma-fleet.stores';

/**
 * The installation CA, confirmation key and registry signing key (SPEC 3.2, 3.6, ADR 0030) as a
 * leaf module, so fleet, confirmations and registries can use them without depending on each
 * other's commands.
 */
@Module({
  providers: [
    { provide: FLEET_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: INSTALLATION_KEY_STORE, useClass: PrismaInstallationKeyStore },
    X509CertificateAuthority,
    { provide: CERTIFICATE_AUTHORITY, useExisting: X509CertificateAuthority },
    { provide: CONFIRMATION_KEY_PROVIDER, useExisting: X509CertificateAuthority },
    { provide: REGISTRY_TOKEN_KEY, useExisting: X509CertificateAuthority },
  ],
  exports: [
    X509CertificateAuthority,
    CERTIFICATE_AUTHORITY,
    CONFIRMATION_KEY_PROVIDER,
    REGISTRY_TOKEN_KEY,
  ],
})
export class InstallationKeysModule {}

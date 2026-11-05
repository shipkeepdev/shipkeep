import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';

import {
  CERTIFICATE_AUTHORITY,
  CONFIRMATION_KEY_PROVIDER,
  FLEET_TRANSACTION,
} from './application/ports';
import { INSTALLATION_KEY_STORE } from './infrastructure/ca/installation-key-store';
import { X509CertificateAuthority } from './infrastructure/ca/x509-certificate-authority';
import { PrismaInstallationKeyStore } from './infrastructure/prisma-fleet.stores';

/**
 * The installation CA and confirmation key (SPEC 3.2, 3.6) as a leaf module, so fleet and
 * confirmations can both use them without depending on each other's commands.
 */
@Module({
  providers: [
    { provide: FLEET_TRANSACTION, useExisting: PrismaUnitOfWork },
    { provide: INSTALLATION_KEY_STORE, useClass: PrismaInstallationKeyStore },
    X509CertificateAuthority,
    { provide: CERTIFICATE_AUTHORITY, useExisting: X509CertificateAuthority },
    { provide: CONFIRMATION_KEY_PROVIDER, useExisting: X509CertificateAuthority },
  ],
  exports: [X509CertificateAuthority, CERTIFICATE_AUTHORITY, CONFIRMATION_KEY_PROVIDER],
})
export class InstallationKeysModule {}

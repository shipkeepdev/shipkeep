import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { InstallationKeysModule } from '../fleet/installation-keys.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { ConfirmationCommands } from './application/confirmation-commands';
import { ConfirmationTargets } from './application/confirmation-targets';
import { ConfirmationVerifier } from './application/confirmation-verifier';
import { CONFIRMATION_STORE, CONFIRMATION_TRANSACTION } from './application/ports';
import { PrismaConfirmationStore } from './infrastructure/prisma-confirmation.store';
import { ConfirmationController } from './interface/confirmation.controller';

/** Confirmation tokens for destructive actions (SPEC 3.6, CLAUDE.md rule 7). */
@Module({
  imports: [IdentityModule, TenantAccessModule, InstallationKeysModule],
  controllers: [ConfirmationController],
  providers: [
    ConfirmationCommands,
    ConfirmationTargets,
    ConfirmationVerifier,
    { provide: CONFIRMATION_STORE, useClass: PrismaConfirmationStore },
    { provide: CONFIRMATION_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  exports: [ConfirmationCommands, ConfirmationTargets, ConfirmationVerifier],
})
export class ConfirmationsModule {}

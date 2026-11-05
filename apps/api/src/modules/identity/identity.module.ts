import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfig } from '../../platform/config/app-config';
import { JobsModule } from '../../platform/jobs/jobs.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { AccountCommands } from './application/account-commands';
import { AccountMutationAuthority } from './application/account-mutation-authority';
import { ApiTokenCommands } from './application/api-token-commands';
import { ApiTokenAuthentication } from './application/api-token-authentication';
import { API_TOKEN_AUTHORITY } from './application/api-token-authority';
import { LiveApiTokenAuthority } from './application/live-api-token-authority';
import { API_TOKEN_STORE } from './application/api-token-store';
import { PrismaApiTokenStore } from './infrastructure/prisma-api-token.store';
import { IDENTITY_MAILER, IDENTITY_SECRETS, PASSWORD_HASHER } from './application/identity-ports';
import { IDENTITY_STORE } from './application/identity-store';
import { IDENTITY_THROTTLE } from './application/identity-throttle';
import { SessionCommands } from './application/session-commands';
import { MFA_CRYPTO } from './application/mfa-crypto';
import { MfaCommands } from './application/mfa-commands';
import { MfaQuery } from './application/mfa-query';
import { MfaController } from './interface/mfa.controller';
import { ApiTokenController } from './interface/api-token.controller';
import { MfaProof } from './application/mfa-proof';
import { MFA_STORE } from './application/mfa-store';
import { EnvelopeMfaCrypto } from './infrastructure/envelope-mfa-crypto';
import { PrismaMfaStore } from './infrastructure/prisma-mfa.store';
import { IdentityMailWorker } from './infrastructure/identity-mail-worker';
import { hashToken, issueToken, matchesTokenHash } from './infrastructure/identity-secrets';
import { PasswordHasher } from './infrastructure/password-hasher';
import { PrivateIdentityReplay } from './infrastructure/private-identity-replay';
import { IdentityReplayInterceptor } from './interface/identity-replay.interceptor';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';
import { PrismaIdentityThrottle } from './infrastructure/prisma-identity-throttle';
import { IDENTITY_DELIVERY, PrivateIdentityMail } from './infrastructure/private-identity-mail';
import { SmtpIdentityDelivery } from './infrastructure/smtp-identity-delivery';
import { IdentityController } from './interface/identity.controller';
import { IdentityGuard } from './interface/identity.guard';
import { IdentityRateGuard } from './interface/identity-rate.guard';

@Module({
  imports: [JobsModule, TenantAccessModule],
  controllers: [IdentityController, MfaController, ApiTokenController],
  providers: [
    AccountCommands,
    AccountMutationAuthority,
    ApiTokenCommands,
    ApiTokenAuthentication,
    { provide: API_TOKEN_STORE, useClass: PrismaApiTokenStore },
    { provide: API_TOKEN_AUTHORITY, useClass: LiveApiTokenAuthority },
    SessionCommands,
    MfaProof,
    MfaCommands,
    MfaQuery,
    { provide: MFA_CRYPTO, useClass: EnvelopeMfaCrypto },
    { provide: MFA_STORE, useClass: PrismaMfaStore },
    PrivateIdentityMail,
    PrivateIdentityReplay,
    IdentityReplayInterceptor,
    IdentityMailWorker,
    { provide: IDENTITY_STORE, useClass: PrismaIdentityStore },
    { provide: PASSWORD_HASHER, useClass: PasswordHasher },
    {
      provide: IDENTITY_SECRETS,
      useValue: { issue: issueToken, hash: hashToken, matches: matchesTokenHash },
    },
    { provide: IDENTITY_MAILER, useExisting: PrivateIdentityMail },
    { provide: IDENTITY_DELIVERY, useClass: SmtpIdentityDelivery },
    { provide: IDENTITY_THROTTLE, useClass: PrismaIdentityThrottle },
    { provide: APP_GUARD, useClass: IdentityGuard },
    { provide: APP_GUARD, useClass: IdentityRateGuard },
  ],
  exports: [AccountMutationAuthority, IdentityReplayInterceptor],
})
export class IdentityModule implements OnModuleInit {
  constructor(
    private readonly config: AppConfig,
    private readonly worker: IdentityMailWorker,
  ) {}

  async onModuleInit(): Promise<void> {
    // An installation without SMTP may serve existing sessions, but cannot accept mail commands.
    if (this.config.get('SMTP_HOST')) await this.worker.start();
  }
}

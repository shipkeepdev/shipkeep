import { Module } from '@nestjs/common';

import { AppsModule } from './modules/apps/apps.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { AuditModule } from './modules/audit/audit.module';
import { ConfirmationsModule } from './modules/confirmations/confirmations.module';
import { DeploymentsModule } from './modules/deployments/deployments.module';
import { FleetModule } from './modules/fleet/fleet.module';
import { GitModule } from './modules/git/git.module';
import { RegistriesModule } from './modules/registries/registries.module';
import { SecretsModule } from './modules/secrets/secrets.module';
import { IdentityModule } from './modules/identity/identity.module';
import { TenantAccessModule } from './modules/organizations/tenant-access.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { AppConfigModule } from './platform/config/config.module';
import { CryptoModule } from './platform/crypto/crypto.module';
import { EventsModule } from './platform/events/events.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';
import { PrismaModule } from './platform/prisma/prisma.module';

/**
 * Root module. Platform modules (config, logging, database, events, crypto, health) come first;
 * bounded contexts under src/modules are added as they land (identity, organizations, fleet...).
 */
@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    PrismaModule,
    EventsModule,
    CryptoModule,
    HealthModule,
    AuditModule,
    FleetModule,
    ConfirmationsModule,
    RegistriesModule,
    GitModule,
    SecretsModule,
    AppsModule,
    DeploymentsModule,
    ObservabilityModule,
    IdentityModule,
    TenantAccessModule,
    OrganizationsModule,
  ],
})
export class AppModule {}

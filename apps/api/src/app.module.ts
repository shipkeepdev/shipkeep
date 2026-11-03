import { Module } from '@nestjs/common';

import { AppConfigModule } from './platform/config/config.module';
import { HealthModule } from './platform/health/health.module';
import { LoggingModule } from './platform/logging/logging.module';
import { PrismaModule } from './platform/prisma/prisma.module';

/**
 * Root module. Platform modules (config, logging, database, health) come first; bounded contexts
 * under src/modules are added here as they land (identity, organizations, fleet, ...).
 */
@Module({
  imports: [AppConfigModule, LoggingModule, PrismaModule, HealthModule],
})
export class AppModule {}

import { Module } from '@nestjs/common';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { AppsModule } from '../apps/apps.module';
import { FleetModule } from '../fleet/fleet.module';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { MetricsIngest } from './application/metrics-ingest';
import { MetricsQueries } from './application/metrics-queries';
import { METRICS_STORE, METRICS_TARGETS, METRICS_TRANSACTION } from './application/ports';
import { PrismaMetricsTargets } from './infrastructure/prisma-metrics-targets.store';
import { VictoriaMetricsStore } from './infrastructure/victoria-metrics.store';
import { MetricsController } from './interface/metrics.controller';

/** Metrics of nodes, containers and routes (ADR 0024, PLAN M6.2). */
@Module({
  imports: [IdentityModule, TenantAccessModule, FleetModule, AppsModule],
  controllers: [MetricsController],
  providers: [
    MetricsIngest,
    MetricsQueries,
    { provide: METRICS_TARGETS, useClass: PrismaMetricsTargets },
    { provide: METRICS_TRANSACTION, useExisting: PrismaUnitOfWork },
    {
      provide: METRICS_STORE,
      useFactory: (config: AppConfig) => {
        const url = config.get('VICTORIAMETRICS_URL');
        return url ? new VictoriaMetricsStore(url) : null;
      },
      inject: [AppConfig],
    },
  ],
})
export class ObservabilityModule {}

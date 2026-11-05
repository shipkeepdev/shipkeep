import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { AppConfig } from '../config/app-config';

import { PrismaClient } from './generated/client';

/**
 * Prisma client for the control plane database, connected through the `pg` driver adapter.
 * Repositories in each module's `infrastructure/` folder depend on this service; domain and
 * application code never import it (CLAUDE.md, rule 5).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    // The connection string is a Secret; it is exposed only here, into the driver.
    super({ adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL').expose() }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe of the connection, used by the readiness endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error: unknown) {
      // Driver errors can echo the connection string; log only a stable code (rule 8).
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      this.logger.warn({ code }, 'database ping failed');
      return false;
    }
  }
}

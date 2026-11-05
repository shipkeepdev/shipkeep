import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

import { AppConfig } from '../config/app-config';

/** PostgreSQL is the only durable queue dependency (ADR 0004). */
@Injectable()
export class JobQueue extends PgBoss implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueue.name);

  constructor(config: AppConfig) {
    super({
      connectionString: config.get('DATABASE_URL').expose(),
      schema: 'shipkeep_jobs',
      // Provisioned by migrations; the runtime login cannot create database schemas.
      createSchema: false,
      max: 5,
    });
    // Library errors may carry driver parameters. Persist/log only an opaque operational signal.
    this.on('error', () => {
      this.logger.error('Job queue operation failed.');
    });
    this.on('warning', () => {
      this.logger.warn('Job queue requires attention.');
    });
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }
  async onModuleDestroy(): Promise<void> {
    await this.stop({ graceful: true, timeout: 30000 });
  }
}

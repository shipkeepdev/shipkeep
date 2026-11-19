import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

import { AppConfig } from '../config/app-config';
import { assertUtcSession, SESSION_ZONE, UTC_SESSION } from '../prisma/utc-session';

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
    // Its connections run in UTC too, from their first statement (utc-session.ts), and that is
    // checked before any job runs.
    await this.utcSessions();
    await this.start();
    const { rows } = await this.getDb().executeSql(SESSION_ZONE);
    const zone: unknown = (rows.at(0) as { zone?: unknown } | undefined)?.zone;
    try {
      assertUtcSession(typeof zone === 'string' ? zone : '');
    } catch (error: unknown) {
      await this.stop({ graceful: false });
      throw error;
    }
  }

  /** Sets UTC on every connection the queue opens; refuses a database that cannot. */
  private async utcSessions(): Promise<void> {
    const database = this.getDb();
    if (!database.setSessionStatements)
      throw new Error('The job queue database cannot set up its sessions.');
    await database.setSessionStatements([UTC_SESSION]);
  }
  async onModuleDestroy(): Promise<void> {
    await this.stop({ graceful: true, timeout: 30000 });
  }
}

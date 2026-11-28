import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';
import { fromPrisma } from 'pg-boss';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import { ExecSessionRegistry, execSessionInterrupted } from '../application/exec-relay';
import {
  type ExecSessionCheckScheduler,
  FLEET_TRANSACTION,
  type FleetTransaction,
} from '../application/ports';

export const EXEC_SESSION_CHECK_QUEUE = 'exec-session-check';
/** A session's check runs this long after the latest time the session can end. */
const CHECK_AFTER_END_MS = 5 * 60_000;
/** How many checks of a stopped process the startup sweep runs at most. */
const SWEEP_LIMIT = 1000;

/** Identifiers only: never what the session ran or showed. */
interface ExecSessionCheck {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * The durable side of an exec session's audit (issue #489). Its check is queued with the session,
 * in the transaction that records its opening, to run once the session must have ended. If no end
 * or interruption was recorded by then, it records the session interrupted: its process stopped,
 * or its end could not be written. A session lives in one API process only, so at start, the checks
 * of the stopped process run at once.
 */
@Injectable()
export class ExecSessionChecks implements ExecSessionCheckScheduler, OnModuleInit {
  private readonly logger = new Logger(ExecSessionChecks.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly database: PrismaUnitOfWork,
    private readonly registry: ExecSessionRegistry,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.createQueue(EXEC_SESSION_CHECK_QUEUE, {
      policy: 'stately',
      retryLimit: 10,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: 3600,
      expireInSeconds: 120,
      retentionSeconds: 7 * 86400,
      deleteAfterSeconds: 7 * 86400,
    });
  }

  async schedule(session: {
    id: string;
    organizationId: string;
    userId: string;
    endsAt: Date;
  }): Promise<void> {
    const check: ExecSessionCheck = {
      organizationId: session.organizationId,
      sessionId: session.id,
      userId: session.userId,
    };
    await this.jobs.send(EXEC_SESSION_CHECK_QUEUE, check, {
      singletonKey: session.id,
      startAfter: new Date(session.endsAt.getTime() + CHECK_AFTER_END_MS),
      // Joins the opening transaction: the check exists exactly when the opening does.
      ...(this.database.inTransaction() ? { db: fromPrisma(this.database.client) } : {}),
    });
  }

  /** Started by `main.ts` before the API listens, so no session of this process exists yet. */
  async start(): Promise<void> {
    await this.jobs.work<unknown>(
      EXEC_SESSION_CHECK_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 30 },
      async (jobs) => {
        for (const job of jobs) await this.check(job.data);
      },
    );
    const interrupted = await this.sweep();
    if (interrupted)
      this.logger.warn(
        { interrupted },
        'exec sessions of the stopped process recorded interrupted',
      );
  }

  /** Runs now the checks still queued: their sessions ended with the process that held them. */
  async sweep(): Promise<number> {
    const { rows } = await this.jobs
      .getDb()
      .executeSql(
        `SELECT data FROM shipkeep_jobs.job WHERE name = $1 AND state IN ('created', 'retry') LIMIT $2`,
        [EXEC_SESSION_CHECK_QUEUE, SWEEP_LIMIT],
      );
    let interrupted = 0;
    for (const row of rows as { data?: unknown }[]) {
      try {
        if ((await this.check(row.data)) === 'interrupted') interrupted++;
      } catch {
        // Its job runs it again later.
        this.logger.warn('an exec session check failed; its job tries again');
      }
    }
    return interrupted;
  }

  /** Records the session interrupted unless it is live or its closing is recorded. */
  async check(data: unknown): Promise<'live' | 'closed' | 'interrupted' | 'ignored'> {
    const fields =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const { organizationId, sessionId, userId } = fields;
    if (!isTenantId(organizationId) || !isTenantId(sessionId) || typeof userId !== 'string')
      return 'ignored';
    if (this.registry.pending(sessionId) || this.registry.ending(sessionId)) {
      // Past the time it must have ended, or its end is still being written: looked at again
      // later, never left without a check.
      await this.schedule({ id: sessionId, organizationId, userId, endsAt: new Date() });
      return 'live';
    }
    const session = { id: sessionId, organizationId };
    return this.transaction.runTenant(organizationId, async () =>
      (await this.registry.closeOnce(session, execSessionInterrupted({ ...session, userId })))
        ? 'interrupted'
        : 'closed',
    );
  }
}

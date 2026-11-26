import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { DeploymentPipeline } from '../application/deployment-pipeline';

import { DEPLOYMENT_QUEUE, DeploymentQueue } from './deployment-queue';

/** While agents work, a deployment is checked again at least this often (lost wake-ups). */
const RECHECK_SECONDS = 15;
/** A run that failed is tried again after this long, doubling up to `RETRY_MAX_SECONDS`. */
const RETRY_FIRST_SECONDS = 15;
const RETRY_MAX_SECONDS = 300;
/** How often, and how many, deployments whose last run failed for good are woken again. */
const SWEEP_MS = 5 * 60_000;
const SWEEP_LIMIT = 500;

/**
 * The deployments whose latest job failed for good: pg-boss gave up on it, and nothing else would
 * run them again. The jobs schema holds no tenant data beyond these identifiers, and each run
 * reads its deployment in its own organization's transaction.
 */
const STRANDED = `
  SELECT DISTINCT ON (j.singleton_key) j.data
  FROM shipkeep_jobs.job j
  WHERE j.name = $1 AND j.state = 'failed'
    AND NOT EXISTS (
      SELECT 1 FROM shipkeep_jobs.job later
      WHERE later.name = j.name AND later.singleton_key = j.singleton_key
        AND later.created_on > j.created_on)
  ORDER BY j.singleton_key, j.created_on DESC
  LIMIT $2`;

/** Runs deployment pipelines from the queue; started by `main.ts` with the agent gateway. */
@Injectable()
export class DeploymentWorker implements OnModuleDestroy {
  private readonly logger = new Logger(DeploymentWorker.name);
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly jobs: JobQueue,
    private readonly queue: DeploymentQueue,
    private readonly pipeline: DeploymentPipeline,
  ) {}

  async start(): Promise<void> {
    await this.jobs.work<unknown>(
      DEPLOYMENT_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data);
      },
    );
    // Deployments left without a job, by retries that ended before a restart or while it ran.
    await this.sweepQuietly();
    this.sweeper = setInterval(() => void this.sweepQuietly(), SWEEP_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /**
   * Runs one deployment. A run that fails is queued again with a growing delay instead of being
   * left to pg-boss retries, which end: a deployment that nothing wakes would keep its
   * application's slot until someone cancelled it (issue #486).
   */
  async handle(data: unknown): Promise<void> {
    const job = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const organizationId = job['organizationId'];
    const deploymentId = job['deploymentId'];
    if (!isTenantId(organizationId) || !isTenantId(deploymentId)) return;
    let outcome: 'wait' | 'done';
    try {
      outcome = await this.pipeline.run(organizationId, deploymentId);
    } catch {
      // Errors may carry driver details: never persist or log them.
      const failures = (typeof job['failures'] === 'number' ? job['failures'] : 0) + 1;
      this.logger.warn({ deploymentId, failures }, 'deployment pipeline run failed');
      // When this enqueue fails too, the job fails, and pg-boss retries it.
      await this.queue.wake(organizationId, deploymentId, retryDelay(failures), failures);
      return;
    }
    if (outcome === 'wait') await this.queue.wake(organizationId, deploymentId, RECHECK_SECONDS);
  }

  /** Wakes the deployments whose latest job failed for good; returns how many. */
  async sweep(): Promise<number> {
    const { rows } = await this.jobs.getDb().executeSql(STRANDED, [DEPLOYMENT_QUEUE, SWEEP_LIMIT]);
    let woken = 0;
    for (const row of rows as { data?: unknown }[]) {
      const data = typeof row.data === 'object' && row.data !== null ? row.data : {};
      const { organizationId, deploymentId } = data as Record<string, unknown>;
      if (!isTenantId(organizationId) || !isTenantId(deploymentId)) continue;
      // A finished deployment's run does nothing; an unfinished one resumes.
      await this.queue.wake(organizationId, deploymentId);
      woken++;
    }
    return woken;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      const woken = await this.sweep();
      if (woken) this.logger.warn({ woken }, 'deployments woken after their runs failed for good');
    } catch {
      this.logger.warn('stranded deployment sweep failed');
    }
  }
}

function retryDelay(failures: number): number {
  return Math.min(RETRY_FIRST_SECONDS * 2 ** Math.min(failures - 1, 10), RETRY_MAX_SECONDS);
}

import { Injectable, Logger } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { DeploymentPipeline } from '../application/deployment-pipeline';

import { DEPLOYMENT_QUEUE, DeploymentQueue } from './deployment-queue';

/** While agents work, a deployment is checked again at least this often (lost wake-ups). */
const RECHECK_SECONDS = 15;

/** Runs deployment pipelines from the queue; started by `main.ts` with the agent gateway. */
@Injectable()
export class DeploymentWorker {
  private readonly logger = new Logger(DeploymentWorker.name);

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
        for (const job of jobs) {
          const data = job.data as Record<string, unknown> | null;
          const organizationId = data?.['organizationId'];
          const deploymentId = data?.['deploymentId'];
          if (!isTenantId(organizationId) || !isTenantId(deploymentId)) continue;
          try {
            if ((await this.pipeline.run(organizationId, deploymentId)) === 'wait')
              await this.queue.wake(organizationId, deploymentId, RECHECK_SECONDS);
          } catch {
            // pg-boss retries the run; errors may carry driver details, never persist them.
            this.logger.warn({ deploymentId }, 'deployment pipeline run failed');
            throw new Error('Deployment pipeline run failed.');
          }
        }
      },
    );
  }
}

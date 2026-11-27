import { Injectable, Logger } from '@nestjs/common';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { ImageRetention } from '../application/image-retention';

export const IMAGE_RETENTION_QUEUE = 'image-retention';
/**
 * Every day at 02:30 UTC, an hour before Distribution's garbage collection frees the layers of the
 * manifests removed (ADR 0030). pg-boss runs a schedule once across control plane instances.
 */
const IMAGE_RETENTION_CRON = '30 2 * * *';

/** Schedules and runs image retention; started by `main.ts` with the deployment worker. */
@Injectable()
export class ImageRetentionWorker {
  private readonly logger = new Logger(ImageRetentionWorker.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly retention: ImageRetention,
  ) {}

  async start(): Promise<void> {
    await this.jobs.createQueue(IMAGE_RETENTION_QUEUE, {
      policy: 'singleton',
      retryLimit: 2,
      retryDelay: 600,
      expireInSeconds: 3600,
    });
    await this.jobs.schedule(IMAGE_RETENTION_QUEUE, IMAGE_RETENTION_CRON);
    await this.jobs.work(IMAGE_RETENTION_QUEUE, { batchSize: 1 }, async () => {
      const { repositories, deleted } = await this.retention.run();
      this.logger.log({ repositories, deleted }, 'image retention done');
    });
  }
}

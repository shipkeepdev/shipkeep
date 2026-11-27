import { Injectable, type OnModuleInit } from '@nestjs/common';
import { fromPrisma } from 'pg-boss';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { GithubPushes } from '../application/ports';
import { GITHUB_PUSH_QUEUE, type PushEvent } from '../domain/github-webhook';

/**
 * pg-boss queue of verified pushes (ADR 0031). A push is sent in the transaction that records its
 * delivery. The deployments context works the queue: GitHub is asked again there, outside the
 * webhook's answer, which GitHub wants within ten seconds.
 */
@Injectable()
export class GithubPushQueue implements GithubPushes, OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly database: PrismaUnitOfWork,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.createQueue(GITHUB_PUSH_QUEUE, {
      retryLimit: 5,
      retryDelay: 15,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 300,
      retentionSeconds: 7 * 86400,
      deleteAfterSeconds: 86400,
    });
  }

  async enqueue(push: PushEvent): Promise<void> {
    await this.jobs.send(GITHUB_PUSH_QUEUE, push, {
      // Joins the delivery's transaction (fixed queue name and schema).
      ...(this.database.inTransaction() ? { db: fromPrisma(this.database.client) } : {}),
    });
  }
}
